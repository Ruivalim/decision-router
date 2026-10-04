// Fails the release when the tag, package.json and the Claude Code plugin manifest disagree on the version.

import plugin from "../.claude-plugin/plugin.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };

const tag = process.argv[2] ?? "";
const want = tag.replace(/^v/, "");
const problems: string[] = [];
if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) problems.push(`tag "${tag}" is not vX.Y.Z`);
if (pkg.version !== want) problems.push(`package.json is ${pkg.version}, tag says ${want}`);
if (plugin.version !== want) problems.push(`.claude-plugin/plugin.json is ${plugin.version}, tag says ${want}`);

if (problems.length) {
	for (const p of problems) console.error(`release check: ${p}`);
	process.exit(1);
}
console.log(`release check: ${tag} ok`);
