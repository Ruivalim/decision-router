# decision-router

Routes a prompt to the right model using TypeSafe's Jev. One core, three faces: the CLI (`src/cli.ts`), the Claude Code plugin (`.claude-plugin/`, `commands/`) and the Pi extension (`src/pi/extension.ts`).

## Commands

`make help` lists everything. `make check` is exactly what CI runs (biome, tsc, tests, build). `make eval` hits the live Jev API and needs a key.

## Runtime rule: Node, not Bun

The npm package runs on Node 20.3+, so code under `src/` uses only `node:` modules and web APIs (`fetch`, `AbortSignal`). No `Bun.*`, `bun:sqlite` or `Bun.$` there. Bun is the dev toolchain: `bun test`, `bun install`, and `scripts/build.ts` (which may use Bun APIs). After touching `src/`, run the built `dist/cli.js` under Node, not just the tests.

## Layout

- `src/decide.ts`: filter, backend call under a timeout, complexity floor, confidence gate, fallback. Never throws for backend trouble.
- `src/backends/jev.ts`: the Jev request (Choice in both orders plus a complexity Score) and answer parsing. Shared with Pi's classifier path, so questions stay plain strings.
- `src/router.ts`: quota + decide + log, what hosts call.
- `src/pi/`: virtual model `decision-router/auto`. Pi packages come from the host at runtime and stay external in the bundle.
- `test/`: no network, no real key. Tests point `XDG_*` at temp dirs.

## Gotchas

- Jev leans toward the first Choice option; that is why the pick question is asked in both orders.
- `pi -p` blocks on an open stdin. When scripting Pi, redirect `</dev/null`.
- Running Pi with `--model` can change the default in `~/.pi/agent/settings.json`; back it up when testing.
