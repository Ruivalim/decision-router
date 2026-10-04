import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { HeuristicBackend } from "./backends/heuristic.ts";
import { type Config, ConfigError, configPath, DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { CredentialError, clearApiKey, getApiKey, setApiKey } from "./credentials.ts";
import { EvalFileError, type EvalReport, parseEvalFile, runEval } from "./eval.ts";
import { exportExu, FeedbackError, logPath, readLog, recordFeedback } from "./log.ts";
import { loadQuota, makeBackend, resolveProfile, route } from "./router.ts";
import { VERSION } from "./version.ts";

const HELP = `decision-router ${VERSION}: pick the right model for a prompt.

Usage:
  decision-router pick [prompt...]        Route a prompt (reads stdin when no prompt is given)
      --profile <name>                    Candidate list to use (default: claude-code)
      --models a,b,c                      Only consider these candidates of the profile
      --backend jev|heuristic             Override the configured backend
      --context-tokens <n>                Tokens the host adds besides the prompt
      --json                              Machine-readable output
      --no-log                            Do not record this decision
      --no-floor                          Ignore the complexity floor
  decision-router auth set|status|clear   Manage the TypeSafe API key (set reads stdin)
  decision-router profiles [--json]       List profiles and their candidates
  decision-router quota [--json]          Show the quota snapshot the filter would use
  decision-router feedback <id|last> <model>
                                          Record the model that should have been picked
  decision-router export [--teacher] [--split <name>]
                                          Print logged decisions as Exu JSONL
  decision-router eval <cases.jsonl> [--profile <name>] [--backend jev,heuristic]
                     [--no-floor] [--verbose] [--json]
                                          Score backends against labeled prompts
  decision-router config path|init        Show or create the config file

Config: ${"$"}XDG_CONFIG_HOME/decision-router/config.json (override with DECISION_ROUTER_CONFIG).
Key: TYPESAFE_API_KEY, else the macOS Keychain, else a 0600 credentials file.`;

class UsageError extends Error {}

export interface Io {
	stdout: (s: string) => void;
	stderr: (s: string) => void;
	readStdin: () => Promise<string>;
	isTTY: boolean;
	env: NodeJS.ProcessEnv;
}

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

const defaultIo = (): Io => ({
	stdout: (s) => process.stdout.write(s),
	stderr: (s) => process.stderr.write(s),
	readStdin: () => readAll(process.stdin),
	isTTY: Boolean(process.stdin.isTTY),
	env: process.env,
});

function list(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function withBackend(config: Config, backend: string | undefined): Config {
	if (backend === undefined) return config;
	if (backend !== "jev" && backend !== "heuristic") throw new UsageError(`unknown backend "${backend}"`);
	return { ...config, backend };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

async function cmdPick(args: string[], io: Io): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			profile: { type: "string", default: "claude-code" },
			models: { type: "string" },
			backend: { type: "string" },
			"context-tokens": { type: "string" },
			json: { type: "boolean", default: false },
			"no-log": { type: "boolean", default: false },
			"no-floor": { type: "boolean", default: false },
		},
	});
	let prompt = positionals.join(" ");
	if (!prompt && !io.isTTY) prompt = await io.readStdin();
	if (!prompt.trim()) throw new UsageError("no prompt: pass it as arguments or on stdin");

	const contextTokens = values["context-tokens"] !== undefined ? Number(values["context-tokens"]) : undefined;
	if (contextTokens !== undefined && !(Number.isInteger(contextTokens) && contextTokens >= 0))
		throw new UsageError("--context-tokens must be a non-negative integer");

	let config = withBackend(loadConfig(io.env), values.backend);
	if (values["no-log"]) config = { ...config, log: false };
	if (values["no-floor"]) config = { ...config, complexityFloor: false };
	const profile = resolveProfile(config, values.profile, list(values.models));
	const { decision, record, quotaError } = await route(prompt, config, {
		host: "cli",
		profileName: values.profile,
		profile,
		backend: makeBackend(config, io.env),
		env: io.env,
		...(contextTokens !== undefined && { contextTokens }),
	});

	if (values.json) {
		io.stdout(`${JSON.stringify({ id: record?.id, ...decision, ...(quotaError && { quotaError }) })}\n`);
		return 0;
	}
	const why = decision.fallback
		? ` [fallback: ${decision.fallback}${decision.error ? `, ${decision.error}` : ""}]`
		: "";
	io.stdout(`${decision.model}${why}\n`);
	const ranked = Object.entries(decision.probabilities).sort((a, b) => b[1] - a[1]);
	if (ranked.length) io.stdout(`  ${ranked.map(([id, p]) => `${id} ${pct(p)}`).join("  ")}\n`);
	const meta = [
		`confidence ${decision.confidence.toFixed(2)}`,
		decision.complexity !== undefined && `complexity ${decision.complexity.toFixed(1)}/4`,
		decision.floor && `floor ${decision.floor}`,
		decision.backendModel ?? decision.backend,
		`${decision.latencyMs}ms`,
		record && `id ${record.id.slice(0, 8)}`,
	].filter(Boolean);
	io.stdout(`  ${meta.join(" · ")}\n`);
	for (const e of decision.excluded) io.stdout(`  excluded ${e.id}: ${e.reason}\n`);
	if (quotaError) io.stderr(`warning: ${quotaError}\n`);
	return 0;
}

async function readSecret(io: Io): Promise<string> {
	if (!io.isTTY) return io.readStdin();
	// Hide the key while it is typed or pasted.
	const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
	const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
	let muted = false;
	out._writeToOutput = (s: string) => {
		if (!muted) out.output.write(s);
	};
	return new Promise((resolve) => {
		rl.question("TypeSafe API key: ", (answer) => {
			rl.close();
			process.stderr.write("\n");
			resolve(answer);
		});
		muted = true;
	});
}

async function cmdAuth(args: string[], io: Io): Promise<number> {
	const sub = args[0];
	if (sub === "set") {
		const where = setApiKey(await readSecret(io), { env: io.env });
		io.stdout(`saved to ${where === "keychain" ? "the macOS Keychain" : "a 0600 credentials file"}\n`);
		if (io.env.TYPESAFE_API_KEY) io.stderr("note: TYPESAFE_API_KEY is set and takes precedence over the saved key\n");
		return 0;
	}
	if (sub === "status") {
		const key = getApiKey({ env: io.env });
		if (!key) {
			io.stdout("no key configured\n");
			return 1;
		}
		io.stdout(`key from ${key.source}: ${key.key.slice(0, 10)}…${key.key.slice(-4)}\n`);
		return 0;
	}
	if (sub === "clear") {
		clearApiKey({ env: io.env });
		io.stdout("saved key removed\n");
		return 0;
	}
	throw new UsageError("usage: decision-router auth set|status|clear");
}

function cmdProfiles(args: string[], io: Io): number {
	const { values } = parseArgs({ args, options: { json: { type: "boolean", default: false } } });
	const config = loadConfig(io.env);
	if (values.json) {
		io.stdout(`${JSON.stringify(config.profiles, null, 2)}\n`);
		return 0;
	}
	for (const [name, p] of Object.entries(config.profiles)) {
		io.stdout(`${name} (fallback: ${p.fallback})\n`);
		for (const c of p.candidates) io.stdout(`  ${c.id.padEnd(28)} ${c.cost.padEnd(6)} ${c.description}\n`);
	}
	return 0;
}

async function cmdQuota(args: string[], io: Io): Promise<number> {
	const { values } = parseArgs({ args, options: { json: { type: "boolean", default: false } } });
	const config = loadConfig(io.env);
	if (config.quota.source === "none") {
		io.stdout('quota source is "none"; set quota.source to "usage-monitor" in the config\n');
		return 0;
	}
	const { snapshot, error } = await loadQuota(config, io.env);
	if (error) io.stderr(`warning: ${error}\n`);
	if (values.json) {
		io.stdout(`${JSON.stringify(snapshot ?? {}, null, 2)}\n`);
		return error ? 1 : 0;
	}
	for (const [key, q] of Object.entries(snapshot ?? {})) {
		const reset = q.hoursUntilReset !== undefined ? `, resets in ${q.hoursUntilReset}h` : "";
		io.stdout(`${key.padEnd(28)} ${q.remainingPercent}% left${reset}\n`);
	}
	return error ? 1 : 0;
}

function cmdFeedback(args: string[], io: Io): number {
	const [id, model] = args;
	if (!id || !model) throw new UsageError("usage: decision-router feedback <id|last> <model>");
	const r = recordFeedback(logPath(io.env), id, model);
	io.stdout(`recorded: ${r.id.slice(0, 8)} should have been ${r.model}\n`);
	return 0;
}

function cmdExport(args: string[], io: Io): number {
	const { values } = parseArgs({
		args,
		options: {
			format: { type: "string", default: "exu" },
			teacher: { type: "boolean", default: false },
			split: { type: "string", default: "train" },
		},
	});
	if (values.format !== "exu") throw new UsageError(`unknown format "${values.format}" (only exu)`);
	const rows = exportExu(readLog(logPath(io.env)), { includeTeacher: values.teacher, split: values.split });
	for (const r of rows) io.stdout(`${JSON.stringify(r)}\n`);
	io.stderr(`${rows.length} records\n`);
	return 0;
}

function printReport(r: EvalReport, io: Io): void {
	io.stdout(
		`${r.backend.padEnd(10)} accuracy ${pct(r.accuracy)} (${r.correct}/${r.total})  under ${r.under}  over ${r.over}  sideways ${r.sideways}  fallbacks ${r.fallbacks}  ${Math.round(r.meanLatencyMs)}ms avg\n`,
	);
}

async function cmdEval(args: string[], io: Io): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			profile: { type: "string", default: "claude-code" },
			backend: { type: "string", default: "jev,heuristic" },
			json: { type: "boolean", default: false },
			verbose: { type: "boolean", default: false },
			"no-floor": { type: "boolean", default: false },
		},
	});
	const file = positionals[0];
	if (!file) throw new UsageError("usage: decision-router eval <cases.jsonl>");
	const config = loadConfig(io.env);
	const profile = resolveProfile(config, values.profile);
	const cases = parseEvalFile(file, profile.candidates);
	const reports: EvalReport[] = [];
	for (const name of list(values.backend) ?? []) {
		const c = withBackend(config, name);
		const backend = name === "heuristic" ? new HeuristicBackend() : makeBackend(c, io.env);
		const report = await runEval(cases, profile.candidates, {
			backend,
			fallback: profile.fallback,
			minConfidence: c.minConfidence,
			timeoutMs: c.timeoutMs,
			minRemainingPercent: c.quota.minRemainingPercent,
			complexityFloor: c.complexityFloor && !values["no-floor"],
		});
		reports.push(report);
		if (!values.json) {
			printReport(report, io);
			if (values.verbose) {
				for (const row of report.rows.filter((x) => x.got !== x.expected)) {
					const fb = row.decision.fallback ? ` (${row.decision.fallback})` : "";
					io.stdout(`    want ${row.expected}, got ${row.got}${fb}: ${row.prompt.slice(0, 90)}\n`);
				}
			}
		}
	}
	if (values.json) io.stdout(`${JSON.stringify(reports, null, 2)}\n`);
	return 0;
}

function cmdConfig(args: string[], io: Io): number {
	const path = configPath(io.env);
	if (args[0] === "path") {
		io.stdout(`${path}\n`);
		return 0;
	}
	if (args[0] === "init") {
		if (existsSync(path)) {
			io.stderr(`${path} already exists, not touching it\n`);
			return 1;
		}
		mkdirSync(dirname(path), { recursive: true });
		const { profiles, ...rest } = DEFAULT_CONFIG;
		writeFileSync(path, `${JSON.stringify({ ...rest, profiles }, null, 2)}\n`);
		io.stdout(`wrote ${path}\n`);
		return 0;
	}
	throw new UsageError("usage: decision-router config path|init");
}

/** A reader that stops early (`| head`) closes the pipe. That ends the output; it is not a failure. */
export function exitQuietlyOnEpipe(
	stream: NodeJS.EventEmitter,
	exit: (code: number) => void = (code) => process.exit(code),
): void {
	stream.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code !== "EPIPE") throw err;
		exit(0);
	});
}

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
	const [cmd, ...rest] = argv;
	try {
		switch (cmd) {
			case "pick":
				return await cmdPick(rest, io);
			case "auth":
				return await cmdAuth(rest, io);
			case "profiles":
				return cmdProfiles(rest, io);
			case "quota":
				return await cmdQuota(rest, io);
			case "feedback":
				return cmdFeedback(rest, io);
			case "export":
				return cmdExport(rest, io);
			case "eval":
				return await cmdEval(rest, io);
			case "config":
				return cmdConfig(rest, io);
			case "--version":
			case "-v":
				io.stdout(`${VERSION}\n`);
				return 0;
			case undefined:
			case "help":
			case "--help":
			case "-h":
				io.stdout(`${HELP}\n`);
				return 0;
			default:
				throw new UsageError(`unknown command "${cmd}". Run decision-router --help`);
		}
	} catch (err) {
		const known =
			err instanceof UsageError ||
			err instanceof ConfigError ||
			err instanceof CredentialError ||
			err instanceof FeedbackError ||
			err instanceof EvalFileError ||
			(err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
		io.stderr(`decision-router: ${(err as Error).message}\n`);
		return known ? 2 : 1;
	}
}
