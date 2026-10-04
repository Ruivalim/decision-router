#!/usr/bin/env bash
# Bumps the version in package.json and the plugin manifest, commits and tags locally.
# Pushing the tag is what publishes: git push origin main --follow-tags
set -euo pipefail

version="${1:?usage: scripts/release.sh X.Y.Z}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "not a version: $version" >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "commit your changes first" >&2; exit 1; }

npm version "$version" --no-git-tag-version >/dev/null
# Only the version line changes, so the manifest keeps its formatting.
VERSION="$version" perl -pi -e 's/"version": "[^"]*"/"version": "$ENV{VERSION}"/ if !$done && ($done = /"version":/)' .claude-plugin/plugin.json
bun run scripts/check-release.ts "v$version"
git add package.json .claude-plugin/plugin.json
git commit -m "chore: release v$version"
git tag -a "v$version" -m "v$version"
echo "tagged v$version. Publish with: git push origin main --follow-tags"
