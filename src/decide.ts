import { pickByTier } from "./backends/heuristic.ts";
import { estimateTokens, filterCandidates } from "./filter.ts";
import type { Backend, Candidate, CostTier, Decision, QuotaSnapshot } from "./types.ts";

const TIER_RANK: Record<CostTier, number> = { low: 0, medium: 1, high: 2 };

/**
 * Tier a task needs, from the 0 to 4 complexity score. The cuts sit halfway between rubric levels:
 * trivial and simple want a low tier, moderate a medium one, hard and very hard a high one.
 */
export function tierForComplexity(score: number): CostTier {
	if (score < 1.5) return "low";
	if (score < 2.5) return "medium";
	return "high";
}

/** TypeSafe's Choice confidence: how far the top probability sits above an even split, 0 to 1. */
export function choiceConfidence(probabilities: Record<string, number>): number {
	const values = Object.values(probabilities);
	const n = values.length;
	if (n <= 1) return 1;
	const max = Math.max(...values);
	return Math.max(0, Math.min(1, (max - 1 / n) / (1 - 1 / n)));
}

export function argmax(probabilities: Record<string, number>): string {
	let best: string | undefined;
	let bestP = -Infinity;
	for (const [id, p] of Object.entries(probabilities)) {
		if (p > bestP) {
			best = id;
			bestP = p;
		}
	}
	if (best === undefined) throw new Error("empty distribution");
	return best;
}

export interface DecideOptions {
	backend: Backend;
	fallback: string;
	minConfidence: number;
	timeoutMs: number;
	quota?: QuotaSnapshot;
	minRemainingPercent: number;
	/** Extra tokens the host will send besides the prompt (conversation so far). */
	contextTokens?: number;
	/** Never pick a tier below what the task's complexity calls for. */
	complexityFloor?: boolean;
	signal?: AbortSignal;
	now?: () => number;
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
	const p = new Promise<never>((_, reject) => {
		if (signal.aborted) return reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
	// The timeout keeps ticking after a fast answer wins the race; its late rejection is expected.
	p.catch(() => {});
	return p;
}

/** Candidates at or above a tier; all of them when none reaches it, so the floor never empties the list. */
function atOrAbove(candidates: Candidate[], floor: CostTier): Candidate[] {
	const ok = candidates.filter((c) => TIER_RANK[c.cost] >= TIER_RANK[floor]);
	return ok.length ? ok : candidates;
}

/** Highest-probability allowed candidate; the cheapest at the floor when the backend gave them nothing. */
function topWithin(probabilities: Record<string, number>, allowed: Candidate[], floor?: CostTier): string {
	const sub: Record<string, number> = {};
	for (const c of allowed) sub[c.id] = probabilities[c.id] ?? 0;
	if (Object.values(sub).some((p) => p > 0)) return argmax(sub);
	return pickByTier(allowed, floor ?? "low").id;
}

/**
 * The configured fallback when it is still allowed, else the cheapest candidate that meets the floor,
 * else (no floor known) the strongest candidate left.
 */
function safeFallback(allowed: Candidate[], fallback: string, floor?: CostTier): string {
	if (allowed.length === 0 || allowed.some((c) => c.id === fallback)) return fallback;
	return pickByTier(allowed, floor ?? "high").id;
}

/**
 * Filter, ask the backend under a time budget, gate on confidence. Never throws for backend trouble:
 * a routing failure must not block the user's prompt, so it degrades to the fallback and says why.
 */
export async function decide(prompt: string, candidates: Candidate[], opts: DecideOptions): Promise<Decision> {
	const now = opts.now ?? Date.now;
	const started = now();
	const { kept, excluded } = filterCandidates(candidates, {
		requiredTokens: estimateTokens(prompt) + (opts.contextTokens ?? 0),
		quota: opts.quota,
		minRemainingPercent: opts.minRemainingPercent,
	});
	const base = { excluded, backend: opts.backend.name };
	const done = (d: Omit<Decision, "latencyMs" | "excluded" | "backend">): Decision => ({
		...base,
		...d,
		latencyMs: now() - started,
	});

	if (kept.length === 0) {
		return done({
			model: opts.fallback,
			confidence: 0,
			probabilities: {},
			fallback: "backend-error",
			error: "every candidate was excluded",
		});
	}
	if (kept.length === 1) {
		const only = (kept[0] as Candidate).id;
		return done({ model: only, confidence: 1, probabilities: { [only]: 1 }, fallback: "single-candidate" });
	}

	const timeout = AbortSignal.timeout(opts.timeoutMs);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	try {
		// Race the signal too: a backend that ignores it must still not hold the user's prompt hostage.
		const result = await Promise.race([opts.backend.decide(prompt, kept, signal), rejectOnAbort(signal)]);
		// Confidence comes from the untouched distribution: it is the decision model's own uncertainty.
		const confidence = choiceConfidence(result.probabilities);
		const floor =
			opts.complexityFloor !== false && result.complexity !== undefined
				? tierForComplexity(result.complexity)
				: undefined;
		const allowed = floor ? atOrAbove(kept, floor) : kept;
		const extra = {
			probabilities: result.probabilities,
			confidence,
			...(result.complexity !== undefined && { complexity: result.complexity }),
			...(floor && { floor }),
			...(result.model !== undefined && { backendModel: result.model }),
		};
		if (confidence < opts.minConfidence) {
			return done({ ...extra, model: safeFallback(allowed, opts.fallback, floor), fallback: "low-confidence" });
		}
		return done({ ...extra, model: topWithin(result.probabilities, allowed, floor) });
	} catch (err) {
		const timedOut = timeout.aborted && !opts.signal?.aborted;
		return done({
			model: safeFallback(kept, opts.fallback),
			confidence: 0,
			probabilities: {},
			fallback: timedOut ? "timeout" : "backend-error",
			error: timedOut ? `no answer within ${opts.timeoutMs}ms` : (err as Error).message,
		});
	}
}
