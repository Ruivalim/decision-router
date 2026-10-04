---
description: Tell decision-router which model the last routed task should have used
argument-hint: <haiku|sonnet|opus>
allowed-tools: Bash(decision-router feedback:*), Bash(npx -y decision-router@latest feedback:*)
---

Record feedback for the most recent decision. The argument must be a single model id made only of letters, digits and `._/:-`; if it is empty or anything else, ask which model instead of running anything.

```bash
decision-router feedback last $ARGUMENTS
```

Run it as a plain command; only if it fails with "command not found", use `npx -y decision-router@latest` in place of `decision-router`. Report the command's output in one line.
