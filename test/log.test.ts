import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DecisionRecord, exportExu, logDecision, readLog, recordFeedback } from "../src/log.ts";
import type { Candidate, Decision } from "../src/types.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const logFile = () => {
	const d = mkdtempSync(join(tmpdir(), "dr-log-"));
	dirs.push(d);
	return join(d, "nested", "decisions.jsonl");
};

const C: Candidate[] = [
	{ id: "haiku", description: "cheap", cost: "low" },
	{ id: "opus", description: "strong", cost: "high" },
];
const decision = (over: Partial<Decision> = {}): Decision => ({
	model: "haiku",
	confidence: 0.6,
	probabilities: { haiku: 0.8, opus: 0.2 },
	backend: "jev",
	excluded: [],
	latencyMs: 300,
	...over,
});
const log = (path: string, prompt = "rename x", d = decision()) =>
	logDecision(path, { host: "cli", profile: "claude-code", prompt, candidates: C, decision: d }, 50);

test("decisions append as private JSONL and prompts are truncated", () => {
	const path = logFile();
	const r = log(path, "p".repeat(500));
	expect(r.prompt.length).toBeLessThanOrEqual(50);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(readLog(path)).toEqual([r]);
});

test("torn and foreign lines are skipped", () => {
	const path = logFile();
	log(path);
	appendFileSync(path, '{"kind":"decis\n{"foo":1}\n\n');
	log(path);
	expect(readLog(path).length).toBe(2);
});

test("feedback by prefix, by last, and its failure modes", () => {
	const path = logFile();
	const a = log(path);
	const b = log(path);
	expect(recordFeedback(path, a.id.slice(0, 8), "opus").id).toBe(a.id);
	expect(recordFeedback(path, "last", "haiku").id).toBe(b.id);
	expect(() => recordFeedback(path, "zzzz", "opus")).toThrow(/no decision/);
	expect(() => recordFeedback(path, "", "opus")).toThrow(/matches 2/);
	expect(() => recordFeedback(path, "last", "gpt")).toThrow(/not a candidate/);
	expect(() => recordFeedback(logFile(), "last", "opus")).toThrow(/no decision/);
});

test("export: feedback is a hard label, latest feedback wins", () => {
	const path = logFile();
	const a = log(path);
	recordFeedback(path, a.id, "haiku");
	recordFeedback(path, a.id, "opus");
	const rows = exportExu(readLog(path), { includeTeacher: false, split: "train" });
	expect(rows.length).toBe(1);
	expect(rows[0]?.target).toEqual([0, 1]);
	expect(rows[0]?.question.options.map((o) => o.name)).toEqual(["haiku", "opus"]);
	expect(rows[0]?.family).toBe("model-routing/claude-code");
	expect(rows[0]?.state).toEqual({ task: "rename x" });
});

test("export: teacher targets only when asked, never from fallbacks", () => {
	const path = logFile();
	log(path);
	log(path, "fell back", decision({ fallback: "timeout", probabilities: {} }));
	log(path, "low conf", decision({ fallback: "low-confidence" }));
	expect(exportExu(readLog(path), { includeTeacher: false, split: "train" })).toEqual([]);
	const rows = exportExu(readLog(path), { includeTeacher: true, split: "validation" });
	expect(rows.length).toBe(1);
	expect(rows[0]?.target).toEqual([0.8, 0.2]);
	expect(rows[0]?.split).toBe("validation");
	const sum = rows[0]?.target.reduce((x, y) => x + y, 0) ?? 0;
	expect(sum).toBeCloseTo(1);
});

test("export skips single-candidate decisions (Exu needs at least two options)", () => {
	const rec: DecisionRecord = {
		kind: "decision",
		id: "x",
		ts: "",
		host: "cli",
		profile: "p",
		prompt: "p",
		candidates: [C[0] as Candidate],
		decision: decision(),
	};
	expect(
		exportExu([rec, { kind: "feedback", id: "x", ts: "", model: "haiku" }], { includeTeacher: true, split: "t" }),
	).toEqual([]);
});
