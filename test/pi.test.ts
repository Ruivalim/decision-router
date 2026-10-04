import { expect, test } from "bun:test";
import { HeuristicBackend, pickByTier, rateComplexity } from "../src/backends/heuristic.ts";
import { PiClassifierBackend } from "../src/pi/backend.ts";
import { type CatalogModel, candidatesFromCatalog, splitCandidateId } from "../src/pi/candidates.ts";
import type { Candidate } from "../src/types.ts";

const model = (
	id: string,
	provider: string,
	input: number,
	output: number,
	extra: Partial<CatalogModel> = {},
): CatalogModel => ({
	id,
	name: id.toUpperCase(),
	provider,
	contextWindow: 200_000,
	reasoning: true,
	input: ["text"],
	cost: { input, output },
	...extra,
});

test("catalog candidates are tiered by price thirds and keep quota keys", () => {
	const c = candidatesFromCatalog([
		model("small", "anthropic", 1, 5),
		model("mid", "openai-codex", 5, 15),
		model("big", "anthropic", 15, 75),
		model("free", "local", 0, 0, { reasoning: false, input: ["text", "image"], contextWindow: 32_000 }),
	]);
	expect(c.map((x) => [x.id, x.cost, x.quotaKey])).toEqual([
		["anthropic/small", "low", "Claude"],
		["openai-codex/mid", "low", "Codex"],
		["anthropic/big", "high", "Claude"],
		["local/free", "low", undefined],
	]);
	expect(c[3]?.description).toBe("FREE (local): non-reasoning model, 32k context, reads images.");
	expect(c[3]?.contextWindow).toBe(32_000);
});

test("one priced model or all equal prices: everything is medium", () => {
	expect(candidatesFromCatalog([model("a", "p", 2, 2), model("b", "p", 2, 2)]).map((c) => c.cost)).toEqual([
		"medium",
		"medium",
	]);
	expect(candidatesFromCatalog([])).toEqual([]);
});

test("candidate ids split on the first slash only", () => {
	expect(splitCandidateId("openrouter/meta/llama-4")).toEqual({ provider: "openrouter", modelId: "meta/llama-4" });
	expect(splitCandidateId("noslash")).toBeUndefined();
	expect(splitCandidateId("/x")).toBeUndefined();
	expect(splitCandidateId("x/")).toBeUndefined();
});

const C: Candidate[] = [
	{ id: "a/cheap", description: "c", cost: "low" },
	{ id: "a/pricey", description: "p", cost: "high" },
];

test("Pi classifier backend reads answers and surfaces errors", async () => {
	const ok = new PiClassifierBackend(async (req) => {
		expect(Object.keys(req.questions)).toContain("pick_reversed");
		return {
			stopReason: "stop",
			model: "jev-1.13.0",
			answers: { pick: { type: "choice", probabilities: { "a/pricey": 1 } } },
		};
	}, 1000);
	const r = await ok.decide("x", C, AbortSignal.timeout(1000));
	expect(r.probabilities["a/pricey"]).toBe(1);
	expect(r.model).toBe("jev-1.13.0");

	const bad = new PiClassifierBackend(
		async () => ({ stopReason: "error", answers: {}, errorMessage: "No API key for typesafe" }),
		1000,
	);
	await expect(bad.decide("x", C, AbortSignal.timeout(1000))).rejects.toThrow("No API key");
});

test("heuristic baseline", async () => {
	expect(rateComplexity("rename foo to bar")).toBe(0);
	expect(rateComplexity("fix the login bug")).toBe(2);
	expect(rateComplexity("investigate the race condition in the scheduler")).toBe(3);
	expect(rateComplexity(`investigate ${"x".repeat(3000)}`)).toBe(4);
	expect(pickByTier(C, "medium").id).toBe("a/pricey");
	expect(pickByTier([C[0] as Candidate], "high").id).toBe("a/cheap");
	expect(() => pickByTier([], "low")).toThrow();
	const r = await new HeuristicBackend().decide("rename foo", C);
	expect(r.probabilities).toEqual({ "a/cheap": 1, "a/pricey": 0 });
});
