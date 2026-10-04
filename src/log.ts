import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, truncatePrompt } from "./backends/jev.ts";
import { stateDir } from "./config.ts";
import type { Candidate, Decision } from "./types.ts";

export interface DecisionRecord {
	kind: "decision";
	id: string;
	ts: string;
	host: string;
	profile: string;
	prompt: string;
	candidates: Candidate[];
	decision: Decision;
}

export interface FeedbackRecord {
	kind: "feedback";
	id: string;
	ts: string;
	/** The model that should have been picked. */
	model: string;
}

export type LogRecord = DecisionRecord | FeedbackRecord;

export function logPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.DECISION_ROUTER_LOG || join(stateDir(env), "decisions.jsonl");
}

function append(path: string, record: LogRecord): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function logDecision(
	path: string,
	entry: Omit<DecisionRecord, "kind" | "id" | "ts">,
	maxPromptChars: number,
): DecisionRecord {
	const record: DecisionRecord = {
		kind: "decision",
		id: randomUUID(),
		ts: new Date().toISOString(),
		...entry,
		prompt: truncatePrompt(entry.prompt, maxPromptChars),
	};
	append(path, record);
	return record;
}

/** Skips lines it cannot parse, so one torn write does not lose the rest of the history. */
export function readLog(path: string): LogRecord[] {
	if (!existsSync(path)) return [];
	const out: LogRecord[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const r = JSON.parse(line) as LogRecord;
			if (r && (r.kind === "decision" || r.kind === "feedback") && typeof r.id === "string") out.push(r);
		} catch {
			// torn or foreign line
		}
	}
	return out;
}

export class FeedbackError extends Error {}

/** `id` may be a unique prefix, or `last` for the most recent decision. */
export function recordFeedback(path: string, id: string, model: string): FeedbackRecord {
	const decisions = readLog(path).filter((r): r is DecisionRecord => r.kind === "decision");
	const matches = id === "last" ? decisions.slice(-1) : decisions.filter((d) => d.id.startsWith(id));
	if (matches.length === 0) throw new FeedbackError(`no decision matches "${id}"`);
	if (matches.length > 1) throw new FeedbackError(`"${id}" matches ${matches.length} decisions, use more characters`);
	const target = matches[0] as DecisionRecord;
	if (!target.candidates.some((c) => c.id === model)) {
		throw new FeedbackError(
			`"${model}" was not a candidate in that decision (${target.candidates.map((c) => c.id).join(", ")})`,
		);
	}
	const record: FeedbackRecord = { kind: "feedback", id: target.id, ts: new Date().toISOString(), model };
	append(path, record);
	return record;
}

/** One record of the Exu dataset format (exu-base docs/dataset-format.md). */
export interface ExuRecord {
	id: string;
	state: { task: string };
	question: { kind: "choice"; instruction: string; options: { name: string; description: string }[] };
	target: number[];
	split: string;
	family: string;
	language?: string;
}

export interface ExportOptions {
	/** Also export decisions without feedback, with the backend's distribution as a soft teacher target. */
	includeTeacher: boolean;
	split: string;
}

/**
 * Feedback becomes a hard label, and the latest feedback for a decision wins. Without feedback a
 * decision is exported only when asked, as a teacher distribution, and never when it fell back.
 */
export function exportExu(records: LogRecord[], opts: ExportOptions): ExuRecord[] {
	const feedback = new Map<string, string>();
	for (const r of records) if (r.kind === "feedback") feedback.set(r.id, r.model);

	const out: ExuRecord[] = [];
	for (const r of records) {
		if (r.kind !== "decision" || r.candidates.length < 2) continue;
		const label = feedback.get(r.id);
		let target: number[];
		if (label !== undefined) {
			target = r.candidates.map((c) => (c.id === label ? 1 : 0));
		} else if (opts.includeTeacher && !r.decision.fallback) {
			const probs = r.candidates.map((c) => r.decision.probabilities[c.id] ?? 0);
			const total = probs.reduce((a, b) => a + b, 0);
			if (!(total > 0)) continue;
			target = probs.map((p) => p / total);
		} else {
			continue;
		}
		out.push({
			id: r.id,
			state: { task: r.prompt },
			question: {
				kind: "choice",
				instruction:
					"Which model should handle the request in `task`? Pick the cheapest model that will do the task well.",
				options: r.candidates.map((c) => ({ name: c.id, description: describe(c) })),
			},
			target,
			split: opts.split,
			family: `model-routing/${r.profile}`,
		});
	}
	return out;
}
