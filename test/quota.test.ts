import { expect, test } from "bun:test";
import { filterCandidates } from "../src/filter.ts";
import { fetchUsageMonitor, snapshotFromUsageMonitor, type UsageMonitorStatus } from "../src/quota.ts";

// Shape copied from a real usage-monitor response.
const STATUS: UsageMonitorStatus = {
	providers: [
		{ label: "DeepSeek", status: "ok", balance: { amount: 4.2, currency: "USD" }, windows: [] },
		{ label: "Broke", status: "ok", balance: { amount: 0, currency: "USD" } },
		{
			label: "Claude",
			status: "ok",
			windows: [
				{
					label: "Current session",
					remaining_percent: 88,
					used_percent: 12,
					days_until_reset: 0,
					hours_until_reset: 1,
				},
				{
					label: "Current week (all models)",
					remaining_percent: 81,
					used_percent: 19,
					days_until_reset: 3,
					hours_until_reset: 16,
				},
				{
					label: "Current week (Fable)",
					remaining_percent: 5,
					used_percent: 95,
					days_until_reset: 3,
					hours_until_reset: 16,
				},
			],
		},
		{ label: "Antigravity", status: "unavailable", windows: [] },
		{ label: "Codex", status: "ok", windows: [{ label: "Current week", used_percent: 30 }] },
	],
};

test("shared windows give the provider key, qualified ones add a model key", () => {
	const s = snapshotFromUsageMonitor(STATUS);
	expect(s.Claude).toEqual({ remainingPercent: 81, hoursUntilReset: 88 });
	expect(s["Claude:Fable"]).toEqual({ remainingPercent: 5, hoursUntilReset: 88 });
	expect(s.Codex).toEqual({ remainingPercent: 70 });
	expect(s.DeepSeek).toEqual({ remainingPercent: 100 });
	expect(s.Broke).toEqual({ remainingPercent: 0 });
	expect(s.Antigravity).toBeUndefined();
});

test("quota filter excludes below the floor and keeps unknowns", () => {
	const s = snapshotFromUsageMonitor(STATUS);
	const { kept, excluded } = filterCandidates(
		[
			{ id: "fable", description: "d", cost: "high", quotaKey: "Claude:Fable" },
			{ id: "sonnet", description: "d", cost: "medium", quotaKey: "Claude" },
			{ id: "gemini", description: "d", cost: "medium", quotaKey: "Antigravity" },
			{ id: "local", description: "d", cost: "low" },
		],
		{ requiredTokens: 10, quota: s, minRemainingPercent: 10 },
	);
	expect(kept.map((c) => c.id)).toEqual(["sonnet", "gemini", "local"]);
	expect(excluded[0]?.id).toBe("fable");
});

test("network failure yields an empty snapshot and an error, never a throw", async () => {
	const failing = (async () => {
		throw new Error("ECONNREFUSED");
	}) as unknown as typeof fetch;
	const r = await fetchUsageMonitor({ url: "http://127.0.0.1:1", fetch: failing });
	expect(r.snapshot).toEqual({});
	expect(r.error).toContain("ECONNREFUSED");
});

test("non-200 is an error and sends basic auth when configured", async () => {
	let auth: string | undefined;
	const f = (async (_u: string, init: RequestInit) => {
		auth = (init.headers as Record<string, string>).Authorization;
		return new Response("nope", { status: 401 });
	}) as unknown as typeof fetch;
	const r = await fetchUsageMonitor({ url: "http://x/", user: "u", password: "p", fetch: f });
	expect(r.error).toBe("usage-monitor 401");
	expect(auth).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
});

test("garbage JSON does not throw", async () => {
	const f = (async () => new Response("{not json", { status: 200 })) as unknown as typeof fetch;
	const r = await fetchUsageMonitor({ url: "http://x", fetch: f });
	expect(r.snapshot).toEqual({});
	expect(r.error).toBeDefined();
});
