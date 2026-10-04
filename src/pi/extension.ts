/**
 * decision-router for Pi: registers the virtual model `decision-router/auto`.
 *
 * On each message the user writes, the router asks Jev which candidate fits and dispatches the turn
 * there. Tool follow-ups and retries stay on the model that handled the turn, so prompt caches and
 * thinking signatures stay valid. Candidates come from the `pi` profile in the decision-router config,
 * or from every model Pi has credentials for when there is no such profile.
 *
 * Commands: `/route` explains the last decision, `/route-feedback <model>` records the right answer.
 */

import type { Api, ClassifierContext, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Config, loadConfig, type Profile } from "../config.ts";
import { getApiKey } from "../credentials.ts";
import { estimateTokens } from "../filter.ts";
import { logPath, recordFeedback } from "../log.ts";
import { makeBackend, route } from "../router.ts";
import type { Backend, Candidate, Decision, Exclusion } from "../types.ts";
import { PiClassifierBackend } from "./backend.ts";
import { candidatesFromCatalog, splitCandidateId } from "./candidates.ts";

const PROVIDER = "decision-router";
const MAX_CANDIDATES = 255;

interface RouterState {
	model: string;
}

interface LastDecision {
	decision: Decision;
	recordId?: string;
	candidates: Candidate[];
	profileName: string;
	unavailable: Exclusion[];
}

function messageText(message: Message | undefined): string {
	const content = message?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function conversationTokens(messages: readonly Message[]): number {
	return messages.reduce((n, m) => n + estimateTokens(messageText(m)), 0);
}

function sameModel(a: { provider: string; id: string }, b: { provider: string; id: string }): boolean {
	return a.provider === b.provider && a.id === b.id;
}

function lookup(ctx: ExtensionContext, id: string): Model<Api> | undefined {
	const parts = splitCandidateId(id);
	return parts ? ctx.modelRegistry.find(parts.provider, parts.modelId) : undefined;
}

/** The configured `pi` profile, or one built from the catalog. Either way, only models Pi can call. */
function resolvePiProfile(
	config: Config,
	ctx: ExtensionContext,
): { name: string; profile: Profile; unavailable: Exclusion[] } {
	const configured = config.profiles.pi;
	const unavailable: Exclusion[] = [];
	if (configured) {
		const candidates = configured.candidates.filter((c) => {
			const model = lookup(ctx, c.id);
			if (!model) unavailable.push({ id: c.id, reason: "not in Pi's catalog" });
			else if (!ctx.modelRegistry.hasConfiguredAuth(model))
				unavailable.push({ id: c.id, reason: "no credentials in Pi" });
			else return true;
			return false;
		});
		if (candidates.length === 0) throw new Error("decision-router: no model of the `pi` profile is usable in Pi");
		const fallback = candidates.some((c) => c.id === configured.fallback)
			? configured.fallback
			: (candidates[0] as Candidate).id;
		return { name: "pi", profile: { candidates, fallback }, unavailable };
	}
	const models = ctx.modelRegistry
		.getAvailable()
		.filter((m) => m.provider !== PROVIDER)
		.slice(0, MAX_CANDIDATES);
	const candidates = candidatesFromCatalog(models);
	if (candidates.length === 0) throw new Error("decision-router: Pi has no model with credentials to route to");
	const fallback = (candidates.find((c) => c.cost === "medium") ?? (candidates[0] as Candidate)).id;
	return { name: "pi-catalog", profile: { candidates, fallback }, unavailable };
}

function backendFor(config: Config, ctx: ExtensionContext): Backend {
	if (config.backend === "heuristic" || getApiKey()) return makeBackend(config);
	const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", config.jevModel);
	if (!jev) return makeBackend(config);
	return new PiClassifierBackend(async (request, signal) => {
		const result = await ctx.modelRegistry.classify(jev, request as unknown as ClassifierContext, { signal });
		return {
			stopReason: result.stopReason,
			answers: result.answers,
			model: result.model,
			...(result.errorMessage && { errorMessage: result.errorMessage }),
		};
	}, config.maxPromptChars);
}

function explain(last: LastDecision): string {
	const d = last.decision;
	const lines = [
		`routed to ${d.model}${d.fallback ? ` (fallback: ${d.fallback}${d.error ? `, ${d.error}` : ""})` : ""}`,
	];
	const ranked = Object.entries(d.probabilities).sort((a, b) => b[1] - a[1]);
	if (ranked.length) lines.push(ranked.map(([id, p]) => `${id} ${Math.round(p * 100)}%`).join("  "));
	lines.push(
		[
			`confidence ${d.confidence.toFixed(2)}`,
			d.complexity !== undefined && `complexity ${d.complexity.toFixed(1)}/4`,
			d.floor && `floor ${d.floor}`,
			d.backendModel ?? d.backend,
			`${d.latencyMs}ms`,
			`profile ${last.profileName}`,
		]
			.filter(Boolean)
			.join(" · "),
	);
	for (const e of [...last.unavailable, ...d.excluded]) lines.push(`excluded ${e.id}: ${e.reason}`);
	return lines.join("\n");
}

export default function decisionRouter(pi: ExtensionAPI) {
	let last: LastDecision | undefined;

	pi.registerVirtualModel<RouterState>({
		provider: PROVIDER,
		id: "auto",
		name: "Auto (decision-router)",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
		async route(request, ctx) {
			const config = loadConfig();

			// A failed request moves off the model that failed: a local server that is down or a provider
			// that is overloaded will most likely fail the retry too.
			if (request.reason === "retry" && request.failed) {
				const failed = request.failed.model;
				const previous = request.previous;
				if (previous && !sameModel(previous.model, failed)) {
					return { model: previous.model, thinkingLevel: previous.thinkingLevel ?? request.thinkingLevel };
				}
				const fallback = lookup(ctx, resolvePiProfile(config, ctx).profile.fallback);
				if (fallback && !sameModel(fallback, failed)) {
					ctx.ui.notify(`decision-router: ${failed.provider}/${failed.id} failed, retrying on the fallback`, "warning");
					return { model: fallback, thinkingLevel: request.thinkingLevel };
				}
				return { model: failed, thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel };
			}

			// Same model for everything after the user's message: keeps the prompt cache.
			if (request.reason !== "user" && request.previous) {
				return {
					model: request.previous.model,
					thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel,
				};
			}

			const { name, profile, unavailable } = resolvePiProfile(config, ctx);
			const lastUser = request.messages.filter((m) => m.role === "user").at(-1);
			const prompt = messageText(lastUser);

			let decision: Decision;
			let recordId: string | undefined;
			if (request.reason === "direct" || !prompt.trim()) {
				decision = {
					model: profile.fallback,
					confidence: 0,
					probabilities: {},
					backend: "none",
					fallback: "backend-error",
					error: "no user message to route",
					excluded: [],
					latencyMs: 0,
				};
			} else {
				const result = await route(prompt, config, {
					host: "pi",
					profileName: name,
					profile,
					backend: backendFor(config, ctx),
					contextTokens: conversationTokens(request.messages) - estimateTokens(prompt),
					signal: request.signal,
				});
				decision = result.decision;
				recordId = result.record?.id;
			}
			last = {
				decision,
				candidates: profile.candidates,
				profileName: name,
				unavailable,
				...(recordId && { recordId }),
			};

			const model = lookup(ctx, decision.model);
			if (!model) throw new Error(`decision-router: "${decision.model}" is not in Pi's catalog`);
			if (decision.fallback && decision.fallback !== "single-candidate" && decision.error) {
				ctx.ui.notify(`decision-router fell back to ${decision.model}: ${decision.error}`, "warning");
			}
			const state = request.state?.model === decision.model ? undefined : { model: decision.model };
			return { model, thinkingLevel: request.thinkingLevel, ...(state && { state }) };
		},
	});

	pi.registerCommand("route", {
		description: "Explain the last decision-router decision",
		handler: async (_args, ctx) => {
			ctx.ui.notify(last ? explain(last) : "decision-router has not routed anything yet in this session", "info");
		},
	});

	pi.registerCommand("route-feedback", {
		description: "Record which model the last routed turn should have used",
		getArgumentCompletions: (prefix) => {
			const ids = (last?.candidates ?? []).map((c) => c.id).filter((id) => id.startsWith(prefix));
			return ids.length ? ids.map((id) => ({ value: id, label: id })) : null;
		},
		handler: async (args, ctx) => {
			const model = args.trim();
			if (!last?.recordId) {
				ctx.ui.notify("no logged decision to give feedback on", "warning");
				return;
			}
			if (!model) {
				ctx.ui.notify("usage: /route-feedback <provider/model>", "warning");
				return;
			}
			try {
				recordFeedback(logPath(), last.recordId, model);
				ctx.ui.notify(`recorded: should have been ${model}`, "info");
			} catch (err) {
				ctx.ui.notify((err as Error).message, "error");
			}
		},
	});
}
