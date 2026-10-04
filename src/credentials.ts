import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.ts";

const SERVICE = "decision-router";
const ACCOUNT = "typesafe";

export type KeySource = "env" | "keychain" | "file";

export interface CredentialDeps {
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	/** Runs a command and returns stdout; throws on non-zero exit. */
	run: (cmd: string, args: string[]) => string;
}

const defaultDeps = (): CredentialDeps => ({
	env: process.env,
	platform: process.platform,
	run: (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
});

export function credentialsPath(env: NodeJS.ProcessEnv): string {
	return join(configDir(env), "credentials.json");
}

export class CredentialError extends Error {}

function readFile(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const mode = statSync(path).mode & 0o777;
	if (mode & 0o077) {
		throw new CredentialError(`${path} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 ${path}`);
	}
	const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	const key = data[ACCOUNT];
	return typeof key === "string" && key !== "" ? key : undefined;
}

/** TYPESAFE_API_KEY wins, then the macOS Keychain, then a 0600 file under the config dir. */
export function getApiKey(deps: Partial<CredentialDeps> = {}): { key: string; source: KeySource } | undefined {
	const d = { ...defaultDeps(), ...deps };
	const fromEnv = d.env.TYPESAFE_API_KEY?.trim();
	if (fromEnv) return { key: fromEnv, source: "env" };
	if (d.platform === "darwin") {
		try {
			const key = d.run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]).trim();
			if (key) return { key, source: "keychain" };
		} catch {
			// not in the keychain; fall through to the file
		}
	}
	const key = readFile(credentialsPath(d.env));
	return key ? { key, source: "file" } : undefined;
}

export function setApiKey(key: string, deps: Partial<CredentialDeps> = {}): KeySource {
	const d = { ...defaultDeps(), ...deps };
	const trimmed = key.trim();
	if (!trimmed) throw new CredentialError("empty API key");
	if (d.platform === "darwin") {
		d.run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", trimmed]);
		return "keychain";
	}
	const path = credentialsPath(d.env);
	mkdirSync(configDir(d.env), { recursive: true, mode: 0o700 });
	// Write under the final mode, then rename, so the key never sits in a world-readable file.
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ [ACCOUNT]: trimmed }, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
	return "file";
}

export function clearApiKey(deps: Partial<CredentialDeps> = {}): void {
	const d = { ...defaultDeps(), ...deps };
	if (d.platform === "darwin") {
		try {
			d.run("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
		} catch {
			// nothing stored
		}
	}
	rmSync(credentialsPath(d.env), { force: true });
}
