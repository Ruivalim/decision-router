import type { Backend, BackendResult, Candidate, CostTier } from "../types.ts";

const HARD =
	/\b(architect\w*|design|redesign|race condition|concurren\w*|deadlock|security|vulnerab\w*|migrat\w*|performance|investigate|root cause|why (does|is|do)|trade-?offs?|across the (codebase|repo))\b/i;
const MEDIUM = /\b(implement|feature|fix|bug|test|refactor|build|endpoint|integrat\w*|write|add)\b/i;
const TRIVIAL = /\b(rename|typo|format|lint|what is|list|show me|print|bump|comment)\b/i;

const TIER_RANK: Record<CostTier, number> = { low: 0, medium: 1, high: 2 };

/** Keyword and length rating on the same 0 to 4 scale the Jev complexity question uses. */
export function rateComplexity(prompt: string): number {
	let score = 1;
	if (HARD.test(prompt)) score += 2;
	else if (MEDIUM.test(prompt)) score += 1;
	else if (TRIVIAL.test(prompt)) score -= 1;
	if (prompt.length > 2000) score += 1;
	return Math.max(0, Math.min(4, score));
}

function tierFor(complexity: number): CostTier {
	if (complexity <= 1) return "low";
	if (complexity === 2) return "medium";
	return "high";
}

/**
 * The cheapest candidate at the wanted tier, else the closest tier above it, else the strongest left.
 * Order within a tier follows the catalog.
 */
export function pickByTier(candidates: Candidate[], want: CostTier): Candidate {
	if (candidates.length === 0) throw new Error("no candidates");
	const sorted = [...candidates].sort((a, b) => TIER_RANK[a.cost] - TIER_RANK[b.cost]);
	const atOrAbove = sorted.find((c) => TIER_RANK[c.cost] >= TIER_RANK[want]);
	return atOrAbove ?? (sorted.at(-1) as Candidate);
}

/** Baseline with no network. Used for `backend: "heuristic"` and as the yardstick in `eval`. */
export class HeuristicBackend implements Backend {
	readonly name = "heuristic";

	async decide(prompt: string, candidates: Candidate[]): Promise<BackendResult> {
		const complexity = rateComplexity(prompt);
		const chosen = pickByTier(candidates, tierFor(complexity));
		const probabilities: Record<string, number> = {};
		for (const c of candidates) probabilities[c.id] = c.id === chosen.id ? 1 : 0;
		return { probabilities, complexity };
	}
}
