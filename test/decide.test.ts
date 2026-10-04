import { expect, describe as group, test } from "bun:test";
import { argmax, choiceConfidence, decide, tierForComplexity } from "../src/decide.ts";
import type { Backend, BackendResult, Candidate } from "../src/types.ts";

const C: Candidate[] = [
	{ id: "haiku", description: "cheap", cost: "low", quotaKey: "Claude" },
	{ id: "sonnet", description: "mid", cost: "medium", quotaKey: "Claude" },
	{ id: "opus", description: "strong", cost: "high", contextWindow: 100 },
];

const fixed = (probabilities: Record<string, number>, extra: Partial<BackendResult> = {}): Backend => ({
	name: "fake",
	decide: async () => ({ probabilities, ...extra }),
});

const base = { fallback: "sonnet", minConfidence: 0.3, timeoutMs: 500, minRemainingPercent: 10 };

test("choiceConfidence follows TypeSafe's formula", () => {
	// Docs example: (0.6, 0.3, 0.1) and (0.6, 0.2, 0.2) both give 0.4.
	expect(choiceConfidence({ a: 0.6, b: 0.3, c: 0.1 })).toBeCloseTo(0.4);
	expect(choiceConfidence({ a: 0.6, b: 0.2, c: 0.2 })).toBeCloseTo(0.4);
	expect(choiceConfidence({ a: 1 / 3, b: 1 / 3, c: 1 / 3 })).toBeCloseTo(0);
	expect(choiceConfidence({ a: 1, b: 0 })).toBe(1);
	expect(choiceConfidence({ a: 1 })).toBe(1);
});

test("argmax keeps the first of a tie and rejects empty input", () => {
	expect(argmax({ a: 0.5, b: 0.5 })).toBe("a");
	expect(() => argmax({})).toThrow();
});

test("confident answer wins", async () => {
	const d = await decide("x", C, {
		...base,
		backend: fixed({ haiku: 0.9, sonnet: 0.1, opus: 0 }, { model: "jev-1.13.0", complexity: 0.4 }),
	});
	expect(d.model).toBe("haiku");
	expect(d.fallback).toBeUndefined();
	expect(d.backendModel).toBe("jev-1.13.0");
	expect(d.complexity).toBe(0.4);
});

test("low confidence falls back but keeps the distribution for the log", async () => {
	const d = await decide("x", C, { ...base, backend: fixed({ haiku: 0.4, sonnet: 0.3, opus: 0.3 }) });
	expect(d.model).toBe("sonnet");
	expect(d.fallback).toBe("low-confidence");
	expect(d.probabilities.haiku).toBe(0.4);
});

test("fallback excluded by quota: strongest survivor instead", async () => {
	const d = await decide("x", C, {
		...base,
		backend: fixed({ opus: 0.5, haiku: 0.5 }),
		quota: { Claude: { remainingPercent: 3, hoursUntilReset: 20 } },
	});
	// haiku and sonnet are out, opus alone survives: no backend call needed
	expect(d.model).toBe("opus");
	expect(d.fallback).toBe("single-candidate");
	expect(d.excluded.map((e) => e.id)).toEqual(["haiku", "sonnet"]);
	expect(d.excluded[0]?.reason).toContain("resets in 20h");
});

test("every candidate excluded returns the configured fallback with an error", async () => {
	const d = await decide("y".repeat(1000), C, {
		...base,
		backend: fixed({}),
		quota: { Claude: { remainingPercent: 0 } },
	});
	expect(d.model).toBe("sonnet");
	expect(d.error).toContain("excluded");
});

test("a backend that hangs is cut at the timeout", async () => {
	const hang: Backend = {
		name: "hang",
		decide: (_p, _c, signal) =>
			new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
	};
	const started = Date.now();
	const d = await decide("x", C, { ...base, timeoutMs: 100, backend: hang });
	expect(Date.now() - started).toBeLessThan(400);
	expect(d.fallback).toBe("timeout");
	expect(d.model).toBe("sonnet");
});

test("a backend that ignores the abort signal is still cut at the timeout", async () => {
	const deaf: Backend = { name: "deaf", decide: () => new Promise(() => {}) };
	const started = Date.now();
	const d = await decide("x", C, { ...base, timeoutMs: 100, backend: deaf });
	expect(Date.now() - started).toBeLessThan(400);
	expect(d.fallback).toBe("timeout");
});

test("backend error becomes a fallback with the message", async () => {
	const boom: Backend = { name: "boom", decide: async () => Promise.reject(new Error("TypeSafe API 500")) };
	const d = await decide("x", C, { ...base, backend: boom });
	expect(d.fallback).toBe("backend-error");
	expect(d.error).toBe("TypeSafe API 500");
});

test("caller abort is reported as an error, not a timeout", async () => {
	const ctl = new AbortController();
	ctl.abort(new Error("user cancelled"));
	const b: Backend = {
		name: "b",
		decide: async (_p, _c, signal) => {
			signal.throwIfAborted();
			return { probabilities: { haiku: 1 } };
		},
	};
	const d = await decide("x", C, { ...base, backend: b, signal: ctl.signal });
	expect(d.fallback).toBe("backend-error");
	expect(d.error).toBe("user cancelled");
});

test("context tokens push small windows out", async () => {
	const d = await decide("x", C, { ...base, contextTokens: 5000, backend: fixed({ haiku: 1, sonnet: 0 }) });
	expect(d.excluded).toEqual([{ id: "opus", reason: "context window 100 < ~5001 tokens" }]);
	expect(d.model).toBe("haiku");
});

test("tierForComplexity cuts halfway between rubric levels", () => {
	expect([0, 1.49, 1.5, 2.49, 2.5, 4].map(tierForComplexity)).toEqual([
		"low",
		"low",
		"medium",
		"medium",
		"high",
		"high",
	]);
});

group("complexity floor", () => {
	const cheapLean = { haiku: 0.9, sonnet: 0.1, opus: 0 };

	test("lifts a too-cheap pick to the cheapest model at the floor", async () => {
		const d = await decide("x", C, { ...base, backend: fixed(cheapLean, { complexity: 3.2 }) });
		expect(d.floor).toBe("high");
		expect(d.model).toBe("opus");
		// confidence still reports the decision model's own certainty
		expect(d.confidence).toBeCloseTo(0.85);
	});

	test("keeps the choice ranking among the allowed candidates", async () => {
		const d = await decide("x", C, {
			...base,
			backend: fixed({ haiku: 0.6, sonnet: 0.1, opus: 0.3 }, { complexity: 2 }),
		});
		expect(d.floor).toBe("medium");
		expect(d.model).toBe("opus");
	});

	test("low confidence falls back to the floor, not below it", async () => {
		const d = await decide("x", C, {
			...base,
			backend: fixed({ haiku: 0.4, sonnet: 0.35, opus: 0.25 }, { complexity: 3.9 }),
		});
		expect(d.fallback).toBe("low-confidence");
		expect(d.model).toBe("opus");
	});

	test("can be switched off", async () => {
		const d = await decide("x", C, { ...base, complexityFloor: false, backend: fixed(cheapLean, { complexity: 3.2 }) });
		expect(d.floor).toBeUndefined();
		expect(d.model).toBe("haiku");
	});

	test("a floor no candidate reaches restricts nothing", async () => {
		const cheap: Candidate[] = [
			{ id: "a", description: "a", cost: "low" },
			{ id: "b", description: "b", cost: "medium" },
		];
		const d = await decide("x", cheap, {
			...base,
			fallback: "a",
			backend: fixed({ a: 0.9, b: 0.1 }, { complexity: 4 }),
		});
		expect(d.model).toBe("a");
	});

	test("no complexity answer, no floor", async () => {
		const d = await decide("x", C, { ...base, backend: fixed(cheapLean) });
		expect(d.floor).toBeUndefined();
		expect(d.model).toBe("haiku");
	});
});
