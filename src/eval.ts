import { readFileSync } from "node:fs";
import { type DecideOptions, decide } from "./decide.ts";
import type { Candidate, CostTier, Decision } from "./types.ts";

export interface EvalCase {
	prompt: string;
	expected: string;
}

export interface EvalRow extends EvalCase {
	got: string;
	decision: Decision;
}

export interface EvalReport {
	backend: string;
	total: number;
	correct: number;
	accuracy: number;
	/** Picked a cheaper tier than expected: the task may be done badly. */
	under: number;
	/** Picked a pricier tier than expected: money wasted. */
	over: number;
	/** Wrong pick at the same tier. */
	sideways: number;
	fallbacks: number;
	meanLatencyMs: number;
	rows: EvalRow[];
}

export class EvalFileError extends Error {}

export function parseEvalFile(path: string, candidates: Candidate[]): EvalCase[] {
	const ids = new Set(candidates.map((c) => c.id));
	const cases: EvalCase[] = [];
	readFileSync(path, "utf8")
		.split("\n")
		.forEach((line, i) => {
			if (!line.trim()) return;
			let r: unknown;
			try {
				r = JSON.parse(line);
			} catch {
				throw new EvalFileError(`${path}:${i + 1}: invalid JSON`);
			}
			const c = r as Partial<EvalCase>;
			if (typeof c.prompt !== "string" || !c.prompt.trim()) throw new EvalFileError(`${path}:${i + 1}: missing prompt`);
			if (typeof c.expected !== "string" || !ids.has(c.expected))
				throw new EvalFileError(`${path}:${i + 1}: expected "${c.expected}" is not a candidate`);
			cases.push({ prompt: c.prompt, expected: c.expected });
		});
	if (cases.length === 0) throw new EvalFileError(`${path}: no cases`);
	return cases;
}

const RANK: Record<CostTier, number> = { low: 0, medium: 1, high: 2 };

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

export async function runEval(
	cases: EvalCase[],
	candidates: Candidate[],
	opts: DecideOptions,
	concurrency = 4,
): Promise<EvalReport> {
	const tier = new Map(candidates.map((c) => [c.id, RANK[c.cost]]));
	const rows = await mapLimit(cases, concurrency, async (c) => {
		const decision = await decide(c.prompt, candidates, opts);
		return { ...c, got: decision.model, decision };
	});
	let correct = 0;
	let under = 0;
	let over = 0;
	let sideways = 0;
	for (const r of rows) {
		if (r.got === r.expected) {
			correct++;
			continue;
		}
		const diff = (tier.get(r.got) ?? 0) - (tier.get(r.expected) ?? 0);
		if (diff < 0) under++;
		else if (diff > 0) over++;
		else sideways++;
	}
	return {
		backend: opts.backend.name,
		total: rows.length,
		correct,
		accuracy: correct / rows.length,
		under,
		over,
		sideways,
		fallbacks: rows.filter((r) => r.decision.fallback && r.decision.fallback !== "single-candidate").length,
		meanLatencyMs: rows.reduce((a, r) => a + r.decision.latencyMs, 0) / rows.length,
		rows,
	};
}
