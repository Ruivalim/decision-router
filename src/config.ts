import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Candidate, CostTier } from "./types.ts";

export interface Profile {
	candidates: Candidate[];
	/** Used when the backend fails, times out, or answers with low confidence. */
	fallback: string;
}

export interface QuotaConfig {
	source: "none" | "usage-monitor";
	url?: string;
	/** Candidates whose quota is below this are excluded. */
	minRemainingPercent: number;
}

export interface Config {
	backend: "jev" | "heuristic";
	jevModel: string;
	timeoutMs: number;
	minConfidence: number;
	/** Never route below the tier the task's complexity score calls for. */
	complexityFloor: boolean;
	/** Characters of the prompt sent to the backend. Longer prompts keep head and tail. */
	maxPromptChars: number;
	log: boolean;
	quota: QuotaConfig;
	profiles: Record<string, Profile>;
}

const CLAUDE_CODE_PROFILE: Profile = {
	fallback: "sonnet",
	candidates: [
		{
			id: "haiku",
			cost: "low",
			description:
				"Fast and cheap. Lookups, renames, small mechanical edits, formatting, short summaries, simple shell tasks.",
			notFor: "Multi-file changes, design decisions, debugging with unclear cause.",
		},
		{
			id: "sonnet",
			cost: "medium",
			description:
				"Solid all-round coder. Features, bug fixes, tests, refactors within a module, code review, writing docs.",
			notFor: "Trivial one-line edits (too expensive) or the hardest architecture problems.",
		},
		{
			id: "opus",
			cost: "high",
			description:
				"Strongest reasoning. Architecture and cross-cutting design, subtle concurrency or security bugs, large refactors, ambiguous problems that need judgment.",
			notFor: "Routine work a cheaper model handles well.",
		},
	],
};

export const DEFAULT_CONFIG: Config = {
	backend: "jev",
	jevModel: "jev-latest",
	timeoutMs: 2000,
	minConfidence: 0.3,
	complexityFloor: true,
	maxPromptChars: 16_000,
	log: true,
	quota: { source: "none", minRemainingPercent: 10 },
	profiles: { "claude-code": CLAUDE_CODE_PROFILE },
};

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "decision-router");
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "decision-router");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.DECISION_ROUTER_CONFIG || join(configDir(env), "config.json");
}

export class ConfigError extends Error {}

const COSTS: readonly CostTier[] = ["low", "medium", "high"];

function fail(path: string, message: string): never {
	throw new ConfigError(`${path}: ${message}`);
}

export function parseCandidate(raw: unknown, path: string): Candidate {
	if (typeof raw !== "object" || raw === null) fail(path, "must be an object");
	const c = raw as Record<string, unknown>;
	if (typeof c.id !== "string" || c.id.trim() === "") fail(`${path}.id`, "must be a non-empty string");
	if (typeof c.description !== "string" || c.description.trim() === "")
		fail(`${path}.description`, "must be a non-empty string");
	if (!COSTS.includes(c.cost as CostTier)) fail(`${path}.cost`, `must be one of ${COSTS.join(", ")}`);
	if (c.notFor !== undefined && typeof c.notFor !== "string") fail(`${path}.notFor`, "must be a string");
	if (c.contextWindow !== undefined && !(Number.isInteger(c.contextWindow) && (c.contextWindow as number) > 0))
		fail(`${path}.contextWindow`, "must be a positive integer");
	if (c.quotaKey !== undefined && typeof c.quotaKey !== "string") fail(`${path}.quotaKey`, "must be a string");
	return {
		id: c.id,
		description: c.description,
		cost: c.cost as CostTier,
		...(c.notFor !== undefined && { notFor: c.notFor as string }),
		...(c.contextWindow !== undefined && { contextWindow: c.contextWindow as number }),
		...(c.quotaKey !== undefined && { quotaKey: c.quotaKey as string }),
	};
}

export function parseProfile(raw: unknown, path: string): Profile {
	if (typeof raw !== "object" || raw === null) fail(path, "must be an object");
	const p = raw as Record<string, unknown>;
	if (!Array.isArray(p.candidates) || p.candidates.length === 0)
		fail(`${path}.candidates`, "must be a non-empty array");
	const candidates = p.candidates.map((c, i) => parseCandidate(c, `${path}.candidates[${i}]`));
	const ids = new Set<string>();
	for (const c of candidates) {
		if (ids.has(c.id)) fail(`${path}.candidates`, `duplicate id "${c.id}"`);
		ids.add(c.id);
	}
	if (candidates.length > 255) fail(`${path}.candidates`, "at most 255 candidates (Jev Choice limit)");
	if (typeof p.fallback !== "string") fail(`${path}.fallback`, "must be a string");
	if (!ids.has(p.fallback)) fail(`${path}.fallback`, `"${p.fallback}" is not one of the candidates`);
	return { candidates, fallback: p.fallback };
}

function numberIn(raw: unknown, path: string, min: number, max: number): number {
	if (typeof raw !== "number" || Number.isNaN(raw) || raw < min || raw > max)
		fail(path, `must be a number between ${min} and ${max}`);
	return raw;
}

/** Merge a user config over the defaults. User profiles replace built-in ones with the same name. */
export function parseConfig(raw: unknown): Config {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("config", "must be a JSON object");
	const r = raw as Record<string, unknown>;
	const config: Config = structuredClone(DEFAULT_CONFIG);

	if (r.backend !== undefined) {
		if (r.backend !== "jev" && r.backend !== "heuristic") fail("backend", 'must be "jev" or "heuristic"');
		config.backend = r.backend;
	}
	if (r.jevModel !== undefined) {
		if (typeof r.jevModel !== "string" || r.jevModel === "") fail("jevModel", "must be a non-empty string");
		config.jevModel = r.jevModel;
	}
	if (r.timeoutMs !== undefined) config.timeoutMs = numberIn(r.timeoutMs, "timeoutMs", 100, 60_000);
	if (r.minConfidence !== undefined) config.minConfidence = numberIn(r.minConfidence, "minConfidence", 0, 1);
	if (r.maxPromptChars !== undefined)
		config.maxPromptChars = numberIn(r.maxPromptChars, "maxPromptChars", 200, 100_000);
	if (r.complexityFloor !== undefined) {
		if (typeof r.complexityFloor !== "boolean") fail("complexityFloor", "must be a boolean");
		config.complexityFloor = r.complexityFloor;
	}
	if (r.log !== undefined) {
		if (typeof r.log !== "boolean") fail("log", "must be a boolean");
		config.log = r.log;
	}
	if (r.quota !== undefined) {
		if (typeof r.quota !== "object" || r.quota === null) fail("quota", "must be an object");
		const q = r.quota as Record<string, unknown>;
		if (q.source !== undefined) {
			if (q.source !== "none" && q.source !== "usage-monitor")
				fail("quota.source", 'must be "none" or "usage-monitor"');
			config.quota.source = q.source;
		}
		if (q.url !== undefined) {
			if (typeof q.url !== "string") fail("quota.url", "must be a string");
			config.quota.url = q.url;
		}
		if (q.minRemainingPercent !== undefined)
			config.quota.minRemainingPercent = numberIn(q.minRemainingPercent, "quota.minRemainingPercent", 0, 100);
	}
	if (r.profiles !== undefined) {
		if (typeof r.profiles !== "object" || r.profiles === null) fail("profiles", "must be an object");
		for (const [name, profile] of Object.entries(r.profiles)) {
			config.profiles[name] = parseProfile(profile, `profiles.${name}`);
		}
	}
	return config;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const path = configPath(env);
	if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new ConfigError(`${path}: invalid JSON (${(err as Error).message})`);
	}
	try {
		return parseConfig(raw);
	} catch (err) {
		if (err instanceof ConfigError) throw new ConfigError(`${path}: ${err.message}`);
		throw err;
	}
}
