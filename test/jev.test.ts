import { expect, describe as group, test } from "bun:test";
import { buildRequest, interpretAnswers, JevBackend, JevError, truncatePrompt } from "../src/backends/jev.ts";
import type { Candidate } from "../src/types.ts";

const C: Candidate[] = [
	{ id: "haiku", description: "cheap", cost: "low" },
	{ id: "sonnet", description: "mid", cost: "medium", notFor: "trivia" },
	{ id: "opus", description: "strong", cost: "high" },
];

group("truncatePrompt", () => {
	test("leaves short prompts alone", () => {
		expect(truncatePrompt("abc", 10)).toBe("abc");
	});

	test("keeps head and tail within the budget", () => {
		const long = `HEAD${"x".repeat(1000)}TAIL`;
		const out = truncatePrompt(long, 200);
		expect(out.length).toBeLessThanOrEqual(200);
		expect(out.startsWith("HEAD")).toBe(true);
		expect(out.endsWith("TAIL")).toBe(true);
		expect(out).toContain("[...truncated...]");
	});

	test("budget smaller than the marker does not go negative", () => {
		const out = truncatePrompt("y".repeat(100), 5);
		expect(out).toContain("truncated");
	});
});

group("buildRequest", () => {
	test("asks the same choice in both orders plus complexity", () => {
		const req = buildRequest("do it", C, 1000);
		const q = req.questions;
		expect(Object.keys(q)).toEqual(["pick", "pick_reversed", "complexity"]);
		expect(Object.keys((q.pick as { criteria: object }).criteria)).toEqual(["haiku", "sonnet", "opus"]);
		expect(Object.keys((q.pick_reversed as { criteria: object }).criteria)).toEqual(["opus", "sonnet", "haiku"]);
		expect((q.pick as { criteria: Record<string, string> }).criteria.sonnet).toBe("mid Cost: medium. Not for: trivia");
		expect(req.state.task).toBe("do it");
	});
});

group("interpretAnswers", () => {
	test("averages the two orderings and normalizes", () => {
		const r = interpretAnswers(
			{
				pick: { type: "choice", probabilities: { haiku: 0.8, sonnet: 0.2, opus: 0 } },
				pick_reversed: { type: "choice", probabilities: { haiku: 0.4, sonnet: 0.6, opus: 0 } },
				complexity: { type: "score", score: 1.2 },
			},
			C,
		);
		expect(r.probabilities.haiku).toBeCloseTo(0.6);
		expect(r.probabilities.sonnet).toBeCloseTo(0.4);
		expect(r.probabilities.opus).toBe(0);
		expect(r.complexity).toBe(1.2);
	});

	test("ignores options that are not candidates and bad numbers", () => {
		const r = interpretAnswers(
			{
				pick: {
					type: "choice",
					probabilities: { haiku: 0.5, sonnet: Number.NaN, opus: -1, gpt: 0.5 },
				},
			},
			C,
		);
		expect(r.probabilities).toEqual({ haiku: 1, sonnet: 0, opus: 0 });
	});

	test("uses the one ordering that came back", () => {
		const r = interpretAnswers({ pick_reversed: { type: "choice", probabilities: { opus: 1 } } }, C);
		expect(r.probabilities.opus).toBe(1);
	});

	test("throws when no choice answer exists", () => {
		expect(() => interpretAnswers({ complexity: { type: "score", score: 2 } }, C)).toThrow(/no choice answer/);
	});

	test("throws when every probability is zero", () => {
		expect(() => interpretAnswers({ pick: { type: "choice", probabilities: { gpt: 1 } } }, C)).toThrow(
			/no probability/,
		);
	});

	test("ignores a malformed complexity answer", () => {
		const r = interpretAnswers(
			{ pick: { type: "choice", probabilities: { haiku: 1 } }, complexity: { type: "score", score: "high" } },
			C,
		);
		expect(r.complexity).toBeUndefined();
	});
});

function fakeFetch(responses: (() => Response)[]): { fetch: typeof fetch; calls: RequestInit[] } {
	const calls: RequestInit[] = [];
	const f = (async (_url: string, init: RequestInit) => {
		calls.push(init);
		const next = responses.shift();
		if (!next) throw new Error("unexpected call");
		return next();
	}) as unknown as typeof fetch;
	return { fetch: f, calls };
}

const okBody = {
	model: "jev-1.13.0",
	answers: {
		pick: { type: "choice", choice: "opus", probabilities: { haiku: 0, sonnet: 0.1, opus: 0.9 }, confidence: 0.85 },
		pick_reversed: {
			type: "choice",
			choice: "opus",
			probabilities: { haiku: 0, sonnet: 0.1, opus: 0.9 },
			confidence: 0.85,
		},
		complexity: { type: "score", score: 3.4 },
	},
	usage: { input_tokens: 500, output_tokens: 40 },
};

const json = (status: number, body: unknown) => () =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const backend = (f: typeof fetch) =>
	new JevBackend({ apiKey: "k", model: "jev-latest", maxPromptChars: 1000, fetch: f, baseUrl: "https://x.test/" });

group("JevBackend", () => {
	test("sends the key and model, reads the answer", async () => {
		const { fetch, calls } = fakeFetch([json(200, okBody)]);
		const r = await backend(fetch).decide("hard thing", C, AbortSignal.timeout(1000));
		expect(r.probabilities.opus).toBeCloseTo(0.9);
		expect(r.model).toBe("jev-1.13.0");
		expect(r.inputTokens).toBe(500);
		expect(r.complexity).toBe(3.4);
		expect((calls[0]?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer k");
		expect(JSON.parse(calls[0]?.body as string).model).toBe("jev-latest");
	});

	test("retries once on 429 and succeeds", async () => {
		const { fetch, calls } = fakeFetch([json(429, { error: "slow down" }), json(200, okBody)]);
		const r = await backend(fetch).decide("x", C, AbortSignal.timeout(2000));
		expect(calls.length).toBe(2);
		expect(r.probabilities.opus).toBeCloseTo(0.9);
	});

	test("gives up after the second 529", async () => {
		const { fetch } = fakeFetch([json(529, {}), json(529, { error: "overloaded" })]);
		await expect(backend(fetch).decide("x", C, AbortSignal.timeout(2000))).rejects.toThrow(/529/);
	});

	test("401 points to auth set", async () => {
		const { fetch } = fakeFetch([json(401, { detail: "bad key" })]);
		const err = await backend(fetch)
			.decide("x", C, AbortSignal.timeout(1000))
			.catch((e) => e);
		expect(err).toBeInstanceOf(JevError);
		expect(err.status).toBe(401);
		expect(err.message).toContain("auth set");
	});

	test("abort during the retry wait rejects promptly", async () => {
		const { fetch } = fakeFetch([json(429, {})]);
		const ctl = new AbortController();
		const p = backend(fetch).decide("x", C, ctl.signal);
		setTimeout(() => ctl.abort(new Error("stop")), 20);
		const started = Date.now();
		await expect(p).rejects.toThrow("stop");
		expect(Date.now() - started).toBeLessThan(200);
	});

	test("a 200 without answers is an error, not a crash", async () => {
		const { fetch } = fakeFetch([json(200, { model: "jev" })]);
		await expect(backend(fetch).decide("x", C, AbortSignal.timeout(1000))).rejects.toThrow(/no answers/);
	});
});
