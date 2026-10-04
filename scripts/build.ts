// Bundles for Node (the npm audience may not have Bun) and emits type declarations for the library.
import { chmodSync, rmSync } from "node:fs";
import { $ } from "bun";

rmSync("dist", { recursive: true, force: true });

const entries = [
	{ entry: "src/bin.ts", out: "cli.js" },
	{ entry: "src/index.ts", out: "index.js" },
	{ entry: "src/pi/extension.ts", out: "pi.js" },
];

for (const { entry, out } of entries) {
	const result = await Bun.build({
		entrypoints: [entry],
		outdir: "dist",
		naming: out,
		target: "node",
		format: "esm",
		// Pi supplies these at runtime; bundling them would duplicate its registries.
		external: ["@earendil-works/*"],
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
}
chmodSync("dist/cli.js", 0o755);

await $`tsc -p tsconfig.build.json`;
console.log("built dist/");
