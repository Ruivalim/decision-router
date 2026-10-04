# decision-router

Pick the right model for each prompt. A rename goes to the cheap model, a deadlock investigation goes to the strong one, and you stop paying top-tier prices for one-line edits.

decision-router asks a calibrated decision model ([TypeSafe's Jev](https://docs.typesafe.ai)) which of your candidate models fits a task, in about 300 ms. It ships as:

- a **CLI** (`decision-router pick "..."`), usable from any script or agent;
- a **Claude Code plugin**: `/decision-router:route <task>` picks haiku, sonnet or opus and delegates the task to a subagent on that model;
- a **Pi extension**: a virtual model, `decision-router/auto`, that routes every message you write to the model you configured for that kind of work.

## How it decides

One request to Jev asks three questions in parallel about the prompt:

1. **Which candidate fits?** A Choice over your models, each described in plain words with its cost tier.
2. **The same Choice in reverse order.** Jev leans toward the first option, so the two answers are averaged.
3. **How demanding is the work?** A Score from 0 (trivial) to 4 (very hard).

Then plain code combines them:

- The complexity score sets a **floor**: below 1.5 any tier is allowed, from 1.5 a medium tier, from 2.5 a high tier. The router never picks a model cheaper than the floor. The Choice ranks what is left.
- If Jev's confidence in the Choice is below `minConfidence`, the router uses your **fallback** model, raised to the floor if needed.
- Before asking anything, candidates whose **context window** is too small or whose **quota** is nearly gone are removed.
- If Jev is slow (`timeoutMs`), down, or there is no API key, the router returns the fallback and says why. Routing never blocks your prompt.

On the 30 labeled prompts in `examples/claude-code-cases.jsonl`:

| Router | Accuracy | Too cheap | Too expensive |
| --- | --- | --- | --- |
| Jev with complexity floor | 93% (28/30) | 1 | 1 |
| Jev, Choice only (`--no-floor`) | 73% (22/30) | 8 | 0 |
| Keyword heuristic | 73% (22/30) | 4 | 4 |

Take these numbers as a smoke test, not a benchmark: 30 prompts, labeled while the router was being built, with no independent review. Run `decision-router eval` on prompts from your own work, and send feedback (below) when a pick is wrong.

## Install

```bash
npm install -g decision-router     # Node 22 or newer
decision-router auth set           # paste your TypeSafe API key
decision-router pick "rename foo to bar in utils.ts"
```

```
haiku
  haiku 100%  sonnet 0%  opus 0%
  confidence 1.00 · complexity 0.3/4 · floor low · jev-1.13.0 · 534ms · id b3fb90f9
```

Get a key at [console.typesafe.ai](https://console.typesafe.ai). Jev charges per input token; one routing call is a few hundred tokens.

### Claude Code

```
/plugin marketplace add Ruivalim/decision-router
/plugin install decision-router@decision-router
```

The plugin calls the `decision-router` CLI (installed globally, or through `npx` if not). It adds:

| Command | What it does |
| --- | --- |
| `/decision-router:route <task>` | Picks a model and runs the task in a subagent on it |
| `/decision-router:route-recommend <task>` | Only shows the pick |
| `/decision-router:route-feedback <model>` | Records the model the last task should have used |

### Pi

```bash
pi install npm:decision-router
pi --model decision-router/auto
```

Or pick `Auto (decision-router)` in `/model`. The first message of each turn is routed; tool follow-ups stay on the same model so the prompt cache survives. If a request fails, the retry moves off the failing model. `/route` explains the last decision and `/route-feedback <provider/model>` corrects it.

Without a `pi` profile in the config, the candidates are every model Pi has credentials for, tiered by catalog price, which works but routes better once you describe your models yourself (see below). If you have no decision-router key but Pi has TypeSafe configured, Pi's own TypeSafe provider is used.

## Configuration

`decision-router config init` writes the defaults to `~/.config/decision-router/config.json` (or `$XDG_CONFIG_HOME`, or `$DECISION_ROUTER_CONFIG`). Everything is optional:

```json
{
  "backend": "jev",
  "jevModel": "jev-latest",
  "timeoutMs": 2000,
  "minConfidence": 0.3,
  "complexityFloor": true,
  "maxPromptChars": 16000,
  "log": true,
  "quota": { "source": "usage-monitor", "url": "http://127.0.0.1:9097", "minRemainingPercent": 10 },
  "profiles": {
    "pi": {
      "fallback": "deepseek/deepseek-v4-pro",
      "candidates": [
        {
          "id": "xiaomi/mimo-v2.6-flash",
          "cost": "low",
          "description": "Fast and cheap. Quick answers, lookups, small edits."
        },
        {
          "id": "deepseek/deepseek-v4-pro",
          "cost": "medium",
          "description": "Strong general coder. Features, fixes, tests, refactors."
        },
        {
          "id": "openai-codex/gpt-5.6-sol",
          "cost": "high",
          "quotaKey": "Codex",
          "contextWindow": 272000,
          "description": "Strongest reasoning. Architecture, hard debugging, subtle design trade-offs.",
          "notFor": "Routine work a cheaper model handles well."
        }
      ]
    }
  }
}
```

- A **profile** is a list of candidates plus a fallback. `claude-code` is built in (haiku, sonnet, opus); a profile with the same name replaces it. Pick one with `--profile`.
- **`cost`** is `low`, `medium` or `high`. It doubles as the capability tier the complexity floor uses, so rank models by how strong they are as much as by price.
- **`description`** and **`notFor`** are what Jev reads. Say what a model is good at and what belongs to a neighbor.
- **`quotaKey`** links a candidate to a provider in the quota source. Unknown quota never excludes anything.

### Quota

With `quota.source: "usage-monitor"`, the router reads `GET /api/v1/status/cached` from a usage-monitor server before each decision (800 ms budget) and drops candidates below `minRemainingPercent`. Provider labels become keys: `Claude` for the shared windows, `Claude:Fable` when a window is named after one model. Set `USAGE_MONITOR_USER` and `USAGE_MONITOR_PASSWORD` if the server wants basic auth. `decision-router quota` shows what the filter sees.

### Where the key lives

`decision-router auth set` stores the key in the **macOS Keychain** on a Mac, and in `~/.config/decision-router/credentials.json` with mode `0600` elsewhere (a file readable by other users is refused). `TYPESAFE_API_KEY` in the environment always wins. `auth status` shows where the key came from, masked; `auth clear` removes it.

## Feedback, logs and training data

Every decision is appended to `~/.local/state/decision-router/decisions.jsonl` (private, prompt truncated to `maxPromptChars`; set `"log": false` to turn it off). When a pick is wrong:

```bash
decision-router feedback last opus        # or a decision id prefix
decision-router export > routing.jsonl    # labeled decisions as JSONL
decision-router export --teacher          # also unlabeled ones, with Jev's distribution as a soft target
```

The export follows the Exu dataset format (one typed Choice decision per line, `target` as a distribution), so your corrections can train a local routing model.

## Evaluate

```bash
decision-router eval examples/claude-code-cases.jsonl --verbose
decision-router eval my-cases.jsonl --profile pi --backend jev --no-floor
```

A case file is JSONL with `{"prompt": "...", "expected": "<candidate id>"}` per line. The report splits mistakes into too cheap, too expensive and sideways (same tier).

## Library

```ts
import { decide, JevBackend, DEFAULT_CONFIG } from "decision-router";

const profile = DEFAULT_CONFIG.profiles["claude-code"]!;
const decision = await decide("add pagination to /users", profile.candidates, {
  backend: new JevBackend({ apiKey: process.env.TYPESAFE_API_KEY!, model: "jev-latest", maxPromptChars: 16000 }),
  fallback: profile.fallback,
  minConfidence: 0.3,
  timeoutMs: 2000,
  minRemainingPercent: 10,
});
console.log(decision.model); // "sonnet"
```

## Development

```bash
make setup    # bun install
make check    # biome, tsc, tests, build: what CI runs
make eval     # live comparison against Jev (needs a key)
make help     # everything else
```

The code is TypeScript, developed and tested with Bun, and bundled for Node so the npm package runs without Bun.

Releases are automated with Release Please and npm trusted publishing: conventional commits merged into `main` update a release PR, and merging that PR tags the version, creates the GitHub release and publishes to npm with provenance from `.github/workflows/release.yml`, without a stored npm token. Renovate keeps dependencies and the pinned action digests current. `make publish` is only a manual fallback.

## How this was built

Most of the code, tests and docs were written by an AI coding agent (Claude Code), directed by the author, who made the product and design decisions. The evaluation numbers above come from running the tool; the labels behind them were assigned by the agent during that work.

## License

MIT
