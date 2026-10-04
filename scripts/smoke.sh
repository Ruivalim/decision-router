#!/usr/bin/env bash
# Runs the built bundle under Node the way users call it, pipes included.
set -euo pipefail

node dist/cli.js --version
node dist/cli.js pick --backend heuristic --no-log "rename foo to bar" | grep -qx haiku
# A reader that closes early must not crash the CLI.
node dist/cli.js profiles | head -1 >/dev/null
echo "smoke ok"
