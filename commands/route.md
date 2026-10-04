---
description: Pick the right model for a task with decision-router, then delegate it to a subagent on that model
argument-hint: <task>
allowed-tools: Bash(decision-router pick:*), Bash(npx -y decision-router@latest pick:*)
---

Route this task with decision-router and delegate it.

1. Run the router, passing the task on stdin through a quoted heredoc so nothing in it is expanded by the shell. Run it as a plain command, not wrapped in `if` or `command -v`; only if it fails with "command not found", run the same thing with `npx -y decision-router@latest` in place of `decision-router`:

```bash
decision-router pick --json --profile claude-code <<'DECISION_ROUTER_TASK'
$ARGUMENTS
DECISION_ROUTER_TASK
```

2. Read the JSON. `model` is the pick. If `fallback` is set, the router could not decide on its own (missing key, timeout, low confidence) and `model` is its safe default; mention the `error` field in one line if present.

3. If `model` is one of `haiku`, `sonnet`, `opus` or `fable`, delegate the task with the Agent tool: `subagent_type: "general-purpose"`, `model` set to that value, and the task above as the prompt, verbatim, plus any context from this conversation the subagent needs to do it. If `model` is anything else, do not delegate: say which model was recommended and stop.

4. When the subagent finishes, relay its result. End with one line: `routed to <model> (confidence <confidence>, decision <first 8 chars of id>)`. If the pick looks wrong to the user, they can run `/decision-router:route-feedback <model>`.
