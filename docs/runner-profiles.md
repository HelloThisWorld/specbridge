# Runner profiles

A runner **implementation** is code (`claude-code`, `codex-cli`, `ollama`,
`mock`). A runner **profile** is one named configuration of an
implementation. Several profiles can share an implementation:

```jsonc
// .specbridge/config.json (schema 2.0.0)
{
  "schemaVersion": "2.0.0",
  "defaultRunner": "claude-code",
  "runnerProfiles": {
    "claude-code":   { "runner": "claude-code", "enabled": true },
    "codex-default": {
      "runner": "codex-cli",
      "enabled": false,
      "command": { "executable": "codex", "args": [] },
      "model": null,
      "sandbox": "workspace-write",
      "persistSessions": true,
      "timeoutMs": 1800000
    },
    "codex-fast":    { "runner": "codex-cli", "enabled": false, "model": "o4-mini", "command": { "executable": "codex", "args": [] } },
    "ollama-local":  {
      "runner": "ollama",
      "enabled": false,
      "baseUrl": "http://127.0.0.1:11434",
      "model": null,
      "temperature": 0,
      "timeoutMs": 300000,
      "maximumInputCharacters": 500000,
      "maximumOutputBytes": 2097152
    },
    "ollama-qwen":   { "runner": "ollama", "enabled": false, "model": "qwen3:8b" }
  }
}
```

## Built-in profiles

`claude-code` (enabled), `codex-default` (disabled), `ollama-local`
(disabled), and `mock` (enabled) always exist — configuration entries
override them. New-provider profiles are DISABLED until you enable them
explicitly; nothing is ever silently enabled or selected.

## Rules

- Profile names are unique; unknown runner implementations are rejected.
- Commands are `{ "executable": ..., "args": [...] }` — a shell command
  string is rejected (nothing is ever shell-interpolated).
- Claude profiles keep the existing v0.3–v0.5 field shape (`command`
  executable string + `commandArgs`); migration preserves them unchanged.
- Profiles never store credentials; credential-looking keys are rejected by
  the schema.
- `specbridge runner show <profile>` prints the redacted configuration,
  declared and detected capabilities, operation compatibility, and the
  security boundary.

Per-profile options: executable or endpoint, model, timeout, sandbox mode
(codex: `read-only` narrows task execution; it can never broaden), output
limits, and provider-safe extras. See
[codex-cli-runner.md](codex-cli-runner.md) and
[ollama-runner.md](ollama-runner.md).
