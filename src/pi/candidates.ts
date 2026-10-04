import type { Candidate, CostTier } from "../types.ts";

/** The slice of a Pi catalog model this module reads. */
export interface CatalogModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number;
	reasoning: boolean;
	input: readonly string[];
	cost: { input: number; output: number };
}

/** Pi provider id -> usage-monitor provider label. */
export const DEFAULT_QUOTA_KEYS: Record<string, string> = {
	anthropic: "Claude",
	"openai-codex": "Codex",
	google: "Antigravity",
	"google-antigravity": "Antigravity",
	deepseek: "DeepSeek",
	"kimi-coding": "Kimi Coding",
	xai: "SuperGrok",
};

export function candidateId(m: { provider: string; id: string }): string {
	return `${m.provider}/${m.id}`;
}

export function splitCandidateId(id: string): { provider: string; modelId: string } | undefined {
	const slash = id.indexOf("/");
	if (slash <= 0 || slash === id.length - 1) return undefined;
	return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

const price = (m: CatalogModel) => m.cost.input + m.cost.output;

/**
 * Candidates for users who have not written a Pi profile: every available model, priced into tiers by
 * thirds of the price range, free models in the low tier. Catalog prices are API list prices, so for
 * subscription plans they rank models but say nothing about what is left of the plan; the quota filter
 * covers that.
 */
export function candidatesFromCatalog(
	models: readonly CatalogModel[],
	quotaKeys: Record<string, string> = DEFAULT_QUOTA_KEYS,
): Candidate[] {
	const prices = models.map(price).filter((p) => p > 0);
	const lo = prices.length ? Math.min(...prices) : 0;
	const hi = prices.length ? Math.max(...prices) : 0;
	const tier = (m: CatalogModel): CostTier => {
		const p = price(m);
		// Free means local or unpriced: cheapest to run, and kept away from hard tasks by the floor.
		if (p <= 0) return "low";
		if (hi === lo) return "medium";
		const x = (p - lo) / (hi - lo);
		return x < 1 / 3 ? "low" : x < 2 / 3 ? "medium" : "high";
	};
	return models.map((m) => {
		const traits = [
			m.reasoning ? "reasoning model" : "non-reasoning model",
			`${Math.round(m.contextWindow / 1000)}k context`,
			m.input.includes("image") ? "reads images" : "text only",
		];
		const quotaKey = quotaKeys[m.provider];
		return {
			id: candidateId(m),
			description: `${m.name} (${m.provider}): ${traits.join(", ")}.`,
			cost: tier(m),
			contextWindow: m.contextWindow,
			...(quotaKey && { quotaKey }),
		};
	});
}
