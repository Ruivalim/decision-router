import { type Answers, buildRequest, interpretAnswers, type SystemOneRequest } from "../backends/jev.ts";
import type { Backend, BackendResult, Candidate } from "../types.ts";

/** What Pi's `modelRegistry.classify()` resolves to, reduced to the fields used here. It never rejects. */
export interface ClassifyOutcome {
	stopReason: "stop" | "error" | "aborted";
	answers: Answers;
	model?: string;
	errorMessage?: string;
}

export type Classify = (request: SystemOneRequest, signal: AbortSignal) => Promise<ClassifyOutcome>;

/** Jev through Pi's own TypeSafe provider, so the key configured in Pi is enough. */
export class PiClassifierBackend implements Backend {
	readonly name = "jev";

	constructor(
		private readonly classify: Classify,
		private readonly maxPromptChars: number,
	) {}

	async decide(prompt: string, candidates: Candidate[], signal: AbortSignal): Promise<BackendResult> {
		const outcome = await this.classify(buildRequest(prompt, candidates, this.maxPromptChars), signal);
		if (outcome.stopReason !== "stop") {
			throw new Error(outcome.errorMessage || `classifier stopped: ${outcome.stopReason}`);
		}
		return { ...interpretAnswers(outcome.answers, candidates), ...(outcome.model && { model: outcome.model }) };
	}
}
