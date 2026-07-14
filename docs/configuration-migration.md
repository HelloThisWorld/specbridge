# Configuration migration (v1 → v2)

`.specbridge/config.json` gained a v2 multi-runner schema in v0.6. The v1
schema (v0.3–v0.5) REMAINS fully supported: every command reads both
versions transparently, and migration happens only when you run it.

```bash
specbridge config doctor            # read-only: schema, validity, profiles
specbridge config migrate --dry-run # shows the exact plan; writes nothing
specbridge config migrate --apply   # atomic write + recoverable backup
```

Read-only commands (`runner list/doctor`, generation, refinement, task
execution, `config doctor`, dry runs) never mutate the file.

## What migration does

| v1 | v2 |
| --- | --- |
| `schemaVersion: 1.x` | `schemaVersion: "2.0.0"` |
| `defaultRunner` | preserved (`codex`→`codex-default`, `ollama`→`ollama-local` name mapping only) |
| `runners.claude-code` | `runnerProfiles.claude-code` — every field preserved; behavior unchanged |
| `runners.mock` | `runnerProfiles.mock` — preserved |
| `runners.codex.command` | `runnerProfiles.codex-default.command.executable` — profile added DISABLED |
| — | `runnerProfiles.ollama-local` added DISABLED (loopback default) |
| `verification` | preserved unchanged (trusted commands are never touched) |
| `execution` | preserved unchanged |
| unknown top-level fields | preserved where safe |
| — | `operationDefaults` (all null), `runnerPolicy` (safe defaults), `fallbacks` (empty) added |

Guarantees (tested):

- the effective Claude Code default behavior is preserved;
- Codex and Ollama are NOT enabled;
- no credential value is created;
- automatic fallback stays disabled;
- unmappable v1 runner entries (e.g. `openai-compatible`) are reported and
  remain in the backup (that provider is planned for v0.6.1).

## Safety mechanics

`--apply` copies the original bytes to `config.v1.backup.json` (numbered
suffixes if taken), writes the new file atomically, re-reads and validates
it, and restores the original on any failure. An invalid configuration is
refused at the planning step and the file is left untouched. Restoring the
backup over `config.json` is the complete rollback.
