import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialError, clearApiKey, credentialsPath, getApiKey, setApiKey } from "../src/credentials.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const env = (): NodeJS.ProcessEnv => {
	const d = mkdtempSync(join(tmpdir(), "dr-cred-"));
	dirs.push(d);
	return { XDG_CONFIG_HOME: d };
};
const noRun = () => {
	throw new Error("should not run commands on linux");
};

test("env wins over everything", () => {
	const e = { ...env(), TYPESAFE_API_KEY: "  from-env " };
	setApiKey("from-file", { env: e, platform: "linux", run: noRun });
	expect(getApiKey({ env: e, platform: "linux", run: noRun })).toEqual({ key: "from-env", source: "env" });
});

test("linux: set writes a 0600 file in a 0700 dir and reads it back", () => {
	const e = env();
	expect(setApiKey("secret", { env: e, platform: "linux", run: noRun })).toBe("file");
	const path = credentialsPath(e);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(getApiKey({ env: e, platform: "linux", run: noRun })).toEqual({ key: "secret", source: "file" });
});

test("a credentials file readable by others is refused", () => {
	const e = env();
	setApiKey("secret", { env: e, platform: "linux", run: noRun });
	chmodSync(credentialsPath(e), 0o644);
	expect(() => getApiKey({ env: e, platform: "linux", run: noRun })).toThrow(CredentialError);
	expect(() => getApiKey({ env: e, platform: "linux", run: noRun })).toThrow(/chmod 600/);
});

test("empty key is rejected, absent key is undefined", () => {
	const e = env();
	expect(() => setApiKey("  \n", { env: e, platform: "linux", run: noRun })).toThrow(/empty/);
	expect(getApiKey({ env: e, platform: "linux", run: noRun })).toBeUndefined();
});

test("a file with no typesafe entry counts as no key", () => {
	const e = env();
	const path = credentialsPath(e);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "{}", { mode: 0o600 });
	expect(getApiKey({ env: e, platform: "linux", run: noRun })).toBeUndefined();
});

test("darwin: keychain is used for set, get and clear", () => {
	const e = env();
	const calls: string[][] = [];
	let stored: string | undefined;
	const run = (cmd: string, args: string[]) => {
		calls.push([cmd, ...args]);
		if (args[0] === "add-generic-password") stored = args.at(-1);
		if (args[0] === "find-generic-password") {
			if (!stored) throw new Error("not found");
			return `${stored}\n`;
		}
		if (args[0] === "delete-generic-password") stored = undefined;
		return "";
	};
	expect(setApiKey("mac-key", { env: e, platform: "darwin", run })).toBe("keychain");
	expect(getApiKey({ env: e, platform: "darwin", run })).toEqual({ key: "mac-key", source: "keychain" });
	clearApiKey({ env: e, platform: "darwin", run });
	expect(getApiKey({ env: e, platform: "darwin", run })).toBeUndefined();
	expect(calls.every((c) => c[0] === "security")).toBe(true);
	expect(calls[0]).toContain("-U");
});
