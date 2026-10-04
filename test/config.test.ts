import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, DEFAULT_CONFIG, loadConfig, parseConfig } from "../src/config.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "dr-config-"));
	dirs.push(d);
	return d;
};

const cand = (id: string, extra = {}) => ({ id, description: `${id} desc`, cost: "low", ...extra });

test("missing file gives the defaults, untouched", () => {
	const c = loadConfig({ XDG_CONFIG_HOME: tmp() });
	expect(c).toEqual(DEFAULT_CONFIG);
	c.profiles["claude-code"]?.candidates.pop();
	expect(DEFAULT_CONFIG.profiles["claude-code"]?.candidates.length).toBe(3);
});

test("user values merge over defaults and profiles add up", () => {
	const c = parseConfig({
		timeoutMs: 900,
		quota: { source: "usage-monitor" },
		profiles: { pi: { fallback: "b", candidates: [cand("a"), cand("b", { contextWindow: 1000, quotaKey: "Codex" })] } },
	});
	expect(c.timeoutMs).toBe(900);
	expect(c.quota).toEqual({ source: "usage-monitor", minRemainingPercent: 10 });
	expect(Object.keys(c.profiles)).toEqual(["claude-code", "pi"]);
	expect(c.profiles.pi?.candidates[1]?.quotaKey).toBe("Codex");
});

test.each([
	[{ backend: "gpt" }, /backend/],
	[{ timeoutMs: 10 }, /timeoutMs/],
	[{ minConfidence: 2 }, /minConfidence/],
	[{ minConfidence: "0.5" }, /minConfidence/],
	[{ quota: { source: "cloud" } }, /quota.source/],
	[{ profiles: { x: { fallback: "a", candidates: [] } } }, /non-empty/],
	[{ profiles: { x: { fallback: "z", candidates: [cand("a"), cand("b")] } } }, /not one of the candidates/],
	[{ profiles: { x: { fallback: "a", candidates: [cand("a"), cand("a")] } } }, /duplicate/],
	[{ profiles: { x: { fallback: "a", candidates: [cand("a", { cost: "cheap" })] } } }, /cost/],
	[{ profiles: { x: { fallback: "a", candidates: [cand("a", { contextWindow: -5 })] } } }, /contextWindow/],
	[{ profiles: { x: { fallback: "a", candidates: [{ id: "a", cost: "low" }] } } }, /description/],
	[[], /JSON object/],
])("rejects %j", (raw, message) => {
	expect(() => parseConfig(raw)).toThrow(message);
});

test("more than 255 candidates is rejected", () => {
	const candidates = Array.from({ length: 256 }, (_, i) => cand(`m${i}`));
	expect(() => parseConfig({ profiles: { big: { fallback: "m0", candidates } } })).toThrow(/255/);
});

test("broken JSON names the file", () => {
	const dir = tmp();
	const path = join(dir, "c.json");
	writeFileSync(path, "{ nope");
	expect(() => loadConfig({ DECISION_ROUTER_CONFIG: path })).toThrow(ConfigError);
	expect(() => loadConfig({ DECISION_ROUTER_CONFIG: path })).toThrow(path);
});
