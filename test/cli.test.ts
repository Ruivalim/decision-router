import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Io, main } from "../src/cli.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(extraEnv: NodeJS.ProcessEnv = {}, stdin = "") {
	const d = mkdtempSync(join(tmpdir(), "dr-cli-"));
	dirs.push(d);
	const out: string[] = [];
	const err: string[] = [];
	const io: Io = {
		stdout: (s) => out.push(s),
		stderr: (s) => err.push(s),
		readStdin: async () => stdin,
		isTTY: false,
		// No TYPESAFE_API_KEY and a private config dir: the test never touches the real key.
		env: { XDG_CONFIG_HOME: join(d, "cfg"), XDG_STATE_HOME: join(d, "state"), ...extraEnv },
	};
	return { io, out, err, dir: d, text: () => out.join("") };
}

test("pick with the heuristic backend prints JSON and logs it", async () => {
	const h = harness();
	const code = await main(["pick", "--backend", "heuristic", "--json", "rename", "foo", "to", "bar"], h.io);
	expect(code).toBe(0);
	const r = JSON.parse(h.text());
	expect(r.model).toBe("haiku");
	expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
	const log = readFileSync(join(h.dir, "state", "decision-router", "decisions.jsonl"), "utf8");
	expect(log).toContain("rename foo to bar");
});

test("pick reads stdin and honours --models and --no-log", async () => {
	const h = harness({}, "investigate the deadlock in the worker pool");
	expect(await main(["pick", "--backend", "heuristic", "--models", "haiku,sonnet", "--json", "--no-log"], h.io)).toBe(
		0,
	);
	const r = JSON.parse(h.text());
	expect(Object.keys(r.probabilities)).toEqual(["haiku", "sonnet"]);
	expect(r.model).toBe("sonnet");
	expect(r.id).toBeUndefined();
});

test("jev without a key falls back instead of failing the host", async () => {
	const h = harness();
	expect(await main(["pick", "--json", "hello"], h.io)).toBe(0);
	const r = JSON.parse(h.text());
	expect(r.model).toBe("sonnet");
	expect(r.fallback).toBe("backend-error");
	expect(r.error).toContain("auth set");
});

test("usage errors exit 2 with a message", async () => {
	for (const argv of [
		["nope"],
		["pick"],
		["pick", "--models", "gpt", "x"],
		["pick", "--bogus"],
		["feedback", "x"],
		["pick", "--profile", "zzz", "x"],
	]) {
		const h = harness();
		expect(await main(argv, h.io)).toBe(2);
		expect(h.err.join("")).toStartWith("decision-router: ");
	}
});

test("feedback then export produces an Exu record", async () => {
	const h = harness();
	await main(["pick", "--backend", "heuristic", "--json", "add a test for parseArgs"], h.io);
	expect(await main(["feedback", "last", "opus"], h.io)).toBe(0);
	h.out.length = 0;
	expect(await main(["export"], h.io)).toBe(0);
	const row = JSON.parse(h.text().trim());
	expect(row.question.kind).toBe("choice");
	expect(row.target).toEqual([0, 0, 1]);
});

test("auth set reads stdin into a private file; status masks the key", async () => {
	const h = harness({}, "apikey_testvalue_1234567890\n");
	expect(await main(["auth", "set"], h.io)).toBe(0);
	h.out.length = 0;
	expect(await main(["auth", "status"], h.io)).toBe(0);
	expect(h.text()).not.toContain("testvalue_1234567890");
	expect(h.text()).toContain("7890");
	expect(await main(["auth", "clear"], h.io)).toBe(0);
	expect(await main(["auth", "status"], h.io)).toBe(1);
});

test("config init writes once and profiles lists it", async () => {
	const h = harness();
	expect(await main(["config", "init"], h.io)).toBe(0);
	expect(await main(["config", "init"], h.io)).toBe(1);
	h.out.length = 0;
	expect(await main(["profiles"], h.io)).toBe(0);
	expect(h.text()).toContain("claude-code (fallback: sonnet)");
});

test("eval scores the heuristic on a case file", async () => {
	const h = harness();
	const file = join(h.dir, "cases.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ prompt: "rename foo to bar", expected: "haiku" }),
			JSON.stringify({ prompt: "redesign the plugin architecture", expected: "opus" }),
			JSON.stringify({ prompt: "fix the off-by-one in paginate", expected: "haiku" }),
		].join("\n"),
	);
	expect(await main(["eval", file, "--backend", "heuristic", "--json"], h.io)).toBe(0);
	const [report] = JSON.parse(h.text());
	expect(report.total).toBe(3);
	expect(report.correct).toBe(2);
	expect(report.over).toBe(1);
});

test("eval rejects a case whose expected model is not a candidate", async () => {
	const h = harness();
	const file = join(h.dir, "bad.jsonl");
	writeFileSync(file, JSON.stringify({ prompt: "x", expected: "gpt-9" }));
	expect(await main(["eval", file, "--backend", "heuristic"], h.io)).toBe(2);
	expect(h.err.join("")).toContain("not a candidate");
});
