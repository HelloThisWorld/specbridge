# Runner adapters

This page is an index; the v0.6 capability-driven runner platform lives in:

- **[Runners overview](runners.md)** — profiles, the operation matrix, and
  the CLI commands.
- **[Runner capabilities](runner-capabilities.md)** — categories, support
  levels, capability keys, operation requirements.
- **[Runner adapter contract](runner-adapter-contract.md)** — the FROZEN
  public contract v0.6.1 adapters implement.
- **[Runner profiles](runner-profiles.md)**, **[selection](runner-selection.md)**,
  **[fallback](runner-fallback.md)**, **[conformance](runner-conformance.md)**.
- **[Claude Code runner](claude-code-runner.md)** — local CLI detection,
  capability probing, safe invocation, and limits (unchanged behavior).
- **[Codex CLI runner](codex-cli-runner.md)** and
  **[Ollama runner](ollama-runner.md)** — the v0.6 production adapters.
- **[Runner security](runner-security.md)** and
  **[network/data boundaries](network-data-boundaries.md)**.
- **[Configuration migration](configuration-migration.md)** — the explicit
  v1 → v2 config migration.
- **[Security model](security.md)** — credentials, permissions, untrusted
  input, and process safety.

Unchanged principles: default commands never require a runner, runner
execution is always explicit, configuration lives in
`.specbridge/config.json`, and no credentials are ever stored.
