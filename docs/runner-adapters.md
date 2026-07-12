# Runner adapters

This page moved with the v0.3 runner rework:

- **[Agent runners](agent-runners.md)** — the runner contract, registry,
  statuses, mock scenarios, and the `.specbridge/config.json` schema
  (verification commands, execution policy).
- **[Claude Code runner](claude-code-runner.md)** — local CLI detection,
  capability probing, safe invocation, and limits.
- **[Security model](security.md)** — credentials, permissions, untrusted
  input, and process safety.

Unchanged principles: default commands never require a runner, runner
execution is always explicit, configuration lives in
`.specbridge/config.json`, and no credentials are ever stored.
