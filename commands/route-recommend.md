---
description: Ask decision-router which model fits a task, without running it
argument-hint: <task>
allowed-tools: Bash(decision-router pick:*), Bash(npx -y decision-router@latest pick:*)
---

Run decision-router on this task and report its recommendation. Do not do the task and do not delegate it.

Pass the task through a quoted heredoc so the shell expands nothing. Run it as a plain command, not wrapped in `if` or `command -v`; only if it fails with "command not found", run the same thing with `npx -y decision-router@latest` in place of `decision-router`:

```bash
decision-router pick --profile claude-code <<'DECISION_ROUTER_TASK'
$ARGUMENTS
DECISION_ROUTER_TASK
```

Show the output as is, in a code block, and add nothing beyond one sentence on what the recommendation means for this task.
