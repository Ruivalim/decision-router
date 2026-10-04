import type { Candidate, Exclusion, QuotaSnapshot } from "./types.ts";

/** Rough token count. Four characters per token is close enough to rule out windows that are far too small. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export interface FilterOptions {
	/** Tokens the task needs, prompt plus whatever context the host adds. */
	requiredTokens: number;
	quota?: QuotaSnapshot;
	minRemainingPercent: number;
}

/**
 * Drop the candidates that cannot take the task at all, before the decision model sees them.
 * Missing data never excludes: a candidate without `contextWindow` or without a quota entry stays.
 */
export function filterCandidates(
	candidates: Candidate[],
	opts: FilterOptions,
): { kept: Candidate[]; excluded: Exclusion[] } {
	const kept: Candidate[] = [];
	const excluded: Exclusion[] = [];
	for (const c of candidates) {
		if (c.contextWindow !== undefined && c.contextWindow < opts.requiredTokens) {
			excluded.push({ id: c.id, reason: `context window ${c.contextWindow} < ~${opts.requiredTokens} tokens` });
			continue;
		}
		const q = c.quotaKey ? opts.quota?.[c.quotaKey] : undefined;
		if (q && q.remainingPercent < opts.minRemainingPercent) {
			const reset = q.hoursUntilReset !== undefined ? `, resets in ${q.hoursUntilReset}h` : "";
			excluded.push({ id: c.id, reason: `quota ${q.remainingPercent}% left${reset}` });
			continue;
		}
		kept.push(c);
	}
	return { kept, excluded };
}
