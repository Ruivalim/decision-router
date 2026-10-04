import type { QuotaSnapshot, QuotaStatus } from "./types.ts";

/** Response of a usage-monitor server (`GET /api/v1/status/cached`). Only the fields used here. */
export interface UsageMonitorStatus {
	providers: {
		label: string;
		status?: string;
		balance?: { amount: number; currency?: string };
		windows?: {
			label: string;
			used_percent?: number;
			remaining_percent?: number;
			days_until_reset?: number;
			hours_until_reset?: number;
		}[];
	}[];
}

type Window = NonNullable<UsageMonitorStatus["providers"][number]["windows"]>[number];

function remaining(w: Window): number | undefined {
	if (typeof w.remaining_percent === "number") return w.remaining_percent;
	if (typeof w.used_percent === "number") return 100 - w.used_percent;
	return undefined;
}

/** A window like "Current week (Fable)" belongs to one model; "(all models)" or no qualifier is shared. */
function qualifier(label: string): string | undefined {
	const m = /\(([^)]+)\)\s*$/.exec(label);
	if (!m || /^all models$/i.test(m[1] as string)) return undefined;
	return m[1];
}

function statusOf(windows: Window[]): QuotaStatus | undefined {
	let worst: QuotaStatus | undefined;
	for (const w of windows) {
		const r = remaining(w);
		if (r === undefined) continue;
		if (!worst || r < worst.remainingPercent) {
			const hours =
				w.days_until_reset !== undefined || w.hours_until_reset !== undefined
					? (w.days_until_reset ?? 0) * 24 + (w.hours_until_reset ?? 0)
					: undefined;
			worst = { remainingPercent: r, ...(hours !== undefined && { hoursUntilReset: hours }) };
		}
	}
	return worst;
}

/**
 * Keys are `<provider label>` for the shared windows and `<provider label>:<model>` for the shared
 * windows plus the ones qualified with that model, e.g. `Claude:Fable`. A provider with a balance and
 * no windows reports 0% once the balance runs out, 100% otherwise.
 */
export function snapshotFromUsageMonitor(data: UsageMonitorStatus): QuotaSnapshot {
	const out: QuotaSnapshot = {};
	for (const p of data.providers ?? []) {
		if (p.status === "unavailable") continue;
		const windows = p.windows ?? [];
		if (windows.length === 0 && p.balance && typeof p.balance.amount === "number") {
			out[p.label] = { remainingPercent: p.balance.amount > 0 ? 100 : 0 };
			continue;
		}
		const shared = windows.filter((w) => qualifier(w.label) === undefined);
		const sharedStatus = statusOf(shared);
		if (sharedStatus) out[p.label] = sharedStatus;
		const models = new Set(windows.map((w) => qualifier(w.label)).filter((q): q is string => q !== undefined));
		for (const model of models) {
			const s = statusOf([...shared, ...windows.filter((w) => qualifier(w.label) === model)]);
			if (s) out[`${p.label}:${model}`] = s;
		}
	}
	return out;
}

export interface UsageMonitorOptions {
	url: string;
	user?: string;
	password?: string;
	timeoutMs?: number;
	fetch?: typeof fetch;
}

/** Unknown beats wrong: any failure returns an empty snapshot, which excludes nothing. */
export async function fetchUsageMonitor(
	opts: UsageMonitorOptions,
): Promise<{ snapshot: QuotaSnapshot; error?: string }> {
	const f = opts.fetch ?? globalThis.fetch;
	const headers: Record<string, string> = {};
	if (opts.user && opts.password)
		headers.Authorization = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`;
	try {
		const res = await f(`${opts.url.replace(/\/$/, "")}/api/v1/status/cached`, {
			headers,
			signal: AbortSignal.timeout(opts.timeoutMs ?? 800),
		});
		if (!res.ok) return { snapshot: {}, error: `usage-monitor ${res.status}` };
		return { snapshot: snapshotFromUsageMonitor((await res.json()) as UsageMonitorStatus) };
	} catch (err) {
		return { snapshot: {}, error: `usage-monitor: ${(err as Error).message}` };
	}
}
