/** Relative price tier. The router prefers the cheapest model that can do the task. */
export type CostTier = "low" | "medium" | "high";

/** One model the router may pick. `id` is whatever the host understands. */
export interface Candidate {
	/** Host-facing id: `haiku` in Claude Code, `openai-codex/gpt-5.6-luna` in Pi. */
	id: string;
	/** What the model is good at. Sent to the decision model, so write it for a reader. */
	description: string;
	/** Work this model should not get. Sharpens the boundary between candidates. */
	notFor?: string;
	cost: CostTier;
	/** Context window in tokens. Candidates smaller than the task are filtered out. */
	contextWindow?: number;
	/** Key in the quota source (a usage-monitor provider label, for example). */
	quotaKey?: string;
}

export interface QuotaStatus {
	/** 0 to 100. Lowest remaining percentage across the provider's windows. */
	remainingPercent: number;
	/** Hours until the most constrained window resets, when known. */
	hoursUntilReset?: number;
}

/** quotaKey -> status. A key missing from the map means "unknown", never "empty". */
export type QuotaSnapshot = Record<string, QuotaStatus>;

export interface DecisionInput {
	prompt: string;
	candidates: Candidate[];
	quota?: QuotaSnapshot;
}

/** What a backend returns: a probability per surviving candidate. */
export interface BackendResult {
	probabilities: Record<string, number>;
	/** Complexity of the task on a 0 (trivial) to 4 (very hard) scale, when the backend rates it. */
	complexity?: number;
	/** Versioned model that answered, for the log. */
	model?: string;
	inputTokens?: number;
}

export interface Backend {
	readonly name: string;
	decide(prompt: string, candidates: Candidate[], signal: AbortSignal): Promise<BackendResult>;
}

export interface Exclusion {
	id: string;
	reason: string;
}

export interface Decision {
	/** The candidate id to use. */
	model: string;
	/** 0 to 1, computed from `probabilities` with TypeSafe's Choice formula. */
	confidence: number;
	probabilities: Record<string, number>;
	complexity?: number;
	/** Lowest tier the complexity score allowed, when the floor applied. */
	floor?: CostTier;
	backend: string;
	backendModel?: string;
	/** Set when the router did not use the backend's answer, and why. */
	fallback?: "low-confidence" | "backend-error" | "timeout" | "single-candidate";
	error?: string;
	excluded: Exclusion[];
	latencyMs: number;
}
