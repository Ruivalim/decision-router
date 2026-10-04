import type { Backend, BackendResult, Candidate } from "../types.ts";

/**
 * Request and answer shapes shared by the direct TypeSafe call and Pi's `modelRegistry.classify()`.
 * Pi's classifier types accept only string instructions and criteria, so everything here stays a string.
 */
export interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

export interface ScoreQuestion {
	type: "score";
	instructions: string;
	criteria: string[];
}

export interface SystemOneRequest {
	state: { task: string };
	questions: Record<string, ChoiceQuestion | ScoreQuestion>;
}

export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface ScoreAnswer {
	type: "score";
	score: number;
	confidence: number;
}

/** Loose on purpose: this is parsed from the network, so every field is checked before use. */
export interface RawAnswer {
	type?: string;
	choice?: unknown;
	probabilities?: unknown;
	score?: unknown;
	confidence?: unknown;
}

export type Answers = Record<string, RawAnswer | undefined>;

const PICK_INSTRUCTIONS =
	"Which model should handle the request in `task`? Pick the cheapest model that will do the task well. Reserve expensive models for work that needs them.";

const COMPLEXITY_LEVELS = [
	"Trivial: a lookup, a one-line edit, or a direct question",
	"Simple: a small, well-defined change in one place",
	"Moderate: a normal feature or fix touching a few files",
	"Hard: cross-cutting changes, tricky debugging, or design trade-offs",
	"Very hard: open-ended architecture, subtle concurrency or security issues, or large ambiguous problems",
];

export function describe(c: Candidate): string {
	const notFor = c.notFor ? ` Not for: ${c.notFor}` : "";
	return `${c.description} Cost: ${c.cost}.${notFor}`;
}

/** Keep the head and the tail: the ask is usually at one end of a long prompt. */
export function truncatePrompt(prompt: string, maxChars: number): string {
	if (prompt.length <= maxChars) return prompt;
	const marker = "\n[...truncated...]\n";
	const room = Math.max(0, maxChars - marker.length);
	const head = Math.ceil(room * 0.6);
	return prompt.slice(0, head) + marker + prompt.slice(prompt.length - (room - head));
}

/**
 * Two Choice questions over the same candidates in opposite orders, because Jev 1.13 leans toward the
 * first option. Averaging both cancels most of that bias. Questions run in parallel inside one call.
 */
export function buildRequest(prompt: string, candidates: Candidate[], maxPromptChars: number): SystemOneRequest {
	const forward: Record<string, string> = {};
	for (const c of candidates) forward[c.id] = describe(c);
	const reversed: Record<string, string> = {};
	for (const c of [...candidates].reverse()) reversed[c.id] = describe(c);
	return {
		state: { task: truncatePrompt(prompt, maxPromptChars) },
		questions: {
			pick: { type: "choice", instructions: PICK_INSTRUCTIONS, criteria: forward },
			pick_reversed: { type: "choice", instructions: PICK_INSTRUCTIONS, criteria: reversed },
			complexity: {
				type: "score",
				instructions: "How demanding is the software engineering work requested in `task`?",
				criteria: COMPLEXITY_LEVELS,
			},
		},
	};
}

function choiceProbabilities(answer: RawAnswer | undefined): Record<string, unknown> | undefined {
	if (answer?.type !== "choice" || typeof answer.probabilities !== "object" || answer.probabilities === null)
		return undefined;
	return answer.probabilities as Record<string, unknown>;
}

/** Average the two orderings over the known candidates, ignoring any option the API made up. */
export function interpretAnswers(answers: Answers, candidates: Candidate[]): BackendResult {
	const runs = [choiceProbabilities(answers.pick), choiceProbabilities(answers.pick_reversed)].filter(
		(p): p is Record<string, unknown> => p !== undefined,
	);
	if (runs.length === 0) throw new Error("decision model returned no choice answer");

	const probabilities: Record<string, number> = {};
	for (const c of candidates) {
		const values = runs
			.map((r) => r[c.id])
			.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
		probabilities[c.id] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
	}
	const total = Object.values(probabilities).reduce((a, b) => a + b, 0);
	if (!(total > 0)) throw new Error("decision model gave no probability to any candidate");
	for (const id of Object.keys(probabilities)) probabilities[id] = (probabilities[id] ?? 0) / total;

	const complexity = answers.complexity;
	return {
		probabilities,
		...(complexity?.type === "score" && typeof complexity.score === "number" && { complexity: complexity.score }),
	};
}

export interface JevOptions {
	apiKey: string;
	model: string;
	maxPromptChars: number;
	baseUrl?: string;
	fetch?: typeof fetch;
}

export class JevError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
	}
}

const RETRYABLE = new Set([429, 529]);

export class JevBackend implements Backend {
	readonly name = "jev";
	private readonly fetch: typeof fetch;
	private readonly baseUrl: string;

	constructor(private readonly opts: JevOptions) {
		this.fetch = opts.fetch ?? globalThis.fetch;
		this.baseUrl = (opts.baseUrl ?? "https://api.typesafe.ai").replace(/\/$/, "");
	}

	async decide(prompt: string, candidates: Candidate[], signal: AbortSignal): Promise<BackendResult> {
		const request = buildRequest(prompt, candidates, this.opts.maxPromptChars);
		const body = JSON.stringify({ ...request, model: this.opts.model });
		let res = await this.post(body, signal);
		// One retry on rate limit or overload; the caller's timeout bounds the total wait.
		if (RETRYABLE.has(res.status)) {
			await sleep(250, signal);
			res = await this.post(body, signal);
		}
		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).slice(0, 500);
			const hint = res.status === 401 ? " (check the API key: decision-router auth set)" : "";
			throw new JevError(`TypeSafe API ${res.status}${hint}${detail ? `: ${detail}` : ""}`, res.status);
		}
		const json = (await res.json()) as { model?: string; answers?: Answers; usage?: { input_tokens?: number } };
		if (!json.answers || typeof json.answers !== "object") throw new JevError("TypeSafe API response has no answers");
		return {
			...interpretAnswers(json.answers, candidates),
			...(json.model && { model: json.model }),
			...(json.usage?.input_tokens !== undefined && { inputTokens: json.usage.input_tokens }),
		};
	}

	private post(body: string, signal: AbortSignal): Promise<Response> {
		return this.fetch(`${this.baseUrl}/v1/systemone`, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
			body,
			signal,
		});
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const t = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}
