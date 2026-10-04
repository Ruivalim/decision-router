import { HeuristicBackend } from "./backends/heuristic.ts";
import { JevBackend } from "./backends/jev.ts";
import { type Config, ConfigError, type Profile } from "./config.ts";
import { getApiKey } from "./credentials.ts";
import { decide } from "./decide.ts";
import { type DecisionRecord, logDecision, logPath } from "./log.ts";
import { fetchUsageMonitor } from "./quota.ts";
import type { Backend, Candidate, Decision, QuotaSnapshot } from "./types.ts";

/** Stands in when the key is missing, so routing degrades to the fallback instead of crashing the host. */
class MissingKeyBackend implements Backend {
	readonly name = "jev";
	async decide(): Promise<never> {
		throw new Error("no TypeSafe API key: run `decision-router auth set` or set TYPESAFE_API_KEY");
	}
}

export function makeBackend(config: Config, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Backend {
	if (config.backend === "heuristic") return new HeuristicBackend();
	const key = getApiKey({ env });
	if (!key) return new MissingKeyBackend();
	return new JevBackend({
		apiKey: key.key,
		model: config.jevModel,
		maxPromptChars: config.maxPromptChars,
		...(env.TYPESAFE_BASE_URL && { baseUrl: env.TYPESAFE_BASE_URL }),
		...(fetchImpl && { fetch: fetchImpl }),
	});
}

export function resolveProfile(config: Config, name: string, only?: string[]): Profile {
	const profile = config.profiles[name];
	if (!profile) {
		throw new ConfigError(`unknown profile "${name}". Known: ${Object.keys(config.profiles).join(", ")}`);
	}
	if (!only || only.length === 0) return profile;
	const byId = new Map(profile.candidates.map((c) => [c.id, c]));
	const unknown = only.filter((id) => !byId.has(id));
	if (unknown.length) throw new ConfigError(`not in profile "${name}": ${unknown.join(", ")}`);
	const candidates = only.map((id) => byId.get(id) as Candidate);
	const fallback = only.includes(profile.fallback) ? profile.fallback : (candidates[0] as Candidate).id;
	return { candidates, fallback };
}

export async function loadQuota(
	config: Config,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ snapshot?: QuotaSnapshot; error?: string }> {
	if (config.quota.source !== "usage-monitor") return {};
	return fetchUsageMonitor({
		url: config.quota.url ?? env.USAGE_MONITOR_URL ?? "http://127.0.0.1:9097",
		...(env.USAGE_MONITOR_USER && { user: env.USAGE_MONITOR_USER }),
		...(env.USAGE_MONITOR_PASSWORD && { password: env.USAGE_MONITOR_PASSWORD }),
	});
}

export interface RouteOptions {
	host: string;
	profileName: string;
	profile: Profile;
	backend: Backend;
	contextTokens?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	/** Skip the usage-monitor call, e.g. when the host already has a snapshot. */
	quota?: QuotaSnapshot;
}

export interface RouteResult {
	decision: Decision;
	/** Present when the decision was logged. */
	record?: DecisionRecord;
	quotaError?: string;
}

/** Quota, decision, log: everything a host integration needs in one call. */
export async function route(prompt: string, config: Config, opts: RouteOptions): Promise<RouteResult> {
	const env = opts.env ?? process.env;
	let quota = opts.quota;
	let quotaError: string | undefined;
	if (!quota) {
		const q = await loadQuota(config, env);
		quota = q.snapshot;
		quotaError = q.error;
	}
	const decision = await decide(prompt, opts.profile.candidates, {
		backend: opts.backend,
		fallback: opts.profile.fallback,
		minConfidence: config.minConfidence,
		timeoutMs: config.timeoutMs,
		minRemainingPercent: config.quota.minRemainingPercent,
		complexityFloor: config.complexityFloor,
		...(quota && { quota }),
		...(opts.contextTokens !== undefined && { contextTokens: opts.contextTokens }),
		...(opts.signal && { signal: opts.signal }),
	});
	let record: DecisionRecord | undefined;
	if (config.log) {
		try {
			record = logDecision(
				logPath(env),
				{ host: opts.host, profile: opts.profileName, prompt, candidates: opts.profile.candidates, decision },
				config.maxPromptChars,
			);
		} catch {
			// a full disk must not stop routing
		}
	}
	return { decision, ...(record && { record }), ...(quotaError && { quotaError }) };
}
