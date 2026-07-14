# Agent runners

Runners make SpecBridge model- and agent-agnostic: a runner wraps one way of
invoking an AI coding agent. Default SpecBridge commands never require one;
runner execution is always explicit.

> **v0.6:** runners are now selected through capability-checked PROFILES
> (`claude-code`, `codex-default`, `ollama-local`, `mock`) with a frozen
> adapter contract. Start at **[runners.md](runners.md)**; this page keeps
> the v0.3 execution-contract fundamentals, which are unchanged.

## The contract (v0.3 core, extended by v0.6 capabilities)

Every runner implements the same model-agnostic contract
(`@specbridge/runners`):

| Method | Purpose |
| --- | --- |
| `detect(context)` | Read-only probe: executable, version, authentication, capabilities |
| `generateStage(input, execution)` | Draft one spec stage (returns Markdown in structured output) |
| `executeTask(input, execution)` | Implement exactly one approved task |
| `resumeTask?(input, execution)` | Continue an interrupted session (optional capability) |

Runners return **structured observations only**. A runner never updates task
checkboxes and never decides whether evidence is sufficient — execution
orchestration lives in `@specbridge/execution` and evidence evaluation in
`@specbridge/evidence`. Everything a model reports (`changedFiles`,
`commandsReported`, `testsReported`) is treated as an unverified claim.

### Runner kinds and statuses

Kinds: `mock` (offline, deterministic), `claude-code` (local Claude Code
CLI), `codex-cli` (local Codex CLI, v0.6), `gemini-cli` (local Gemini CLI,
v0.6.1), `ollama` (local model API, authoring-only, v0.6),
`openai-compatible` (model API, authoring-only, v0.6.1), and
`antigravity-cli` (experimental detection only, v0.6.1). The v0.3-era
`unsupported` stubs are gone; the value remains in the vocabulary so
stored data stays readable.

Detection statuses: `available`, `unavailable`, `unauthenticated`,
`incompatible`, `misconfigured`, `error`. Only `available` permits
execution; every other status comes with actionable diagnostics.

Execution outcomes: `completed`, `blocked`, `failed`, `cancelled`,
`timed-out`, `permission-denied`, `malformed-output`, `no-change`.

## CLI

```sh
specbridge runner list                    # all runners with status
specbridge runner doctor claude-code      # deep read-only diagnosis
specbridge runner show claude-code        # effective configuration
```

All three are read-only and support `--json`. `runner doctor` exits `0`
when the runner is available and `3` otherwise.

## Configuration

Runners are configured in `.specbridge/config.json` (versioned schema
`1.0.0`; a v0.2 config file keeps working — every new field has a safe
default):

```json
{
  "schemaVersion": "1.0.0",
  "defaultRunner": "claude-code",
  "runners": {
    "claude-code": {
      "enabled": true,
      "command": "claude",
      "model": null,
      "maxTurns": 30,
      "timeoutMs": 1800000,
      "permissionMode": "acceptEdits",
      "tools": ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
      "allowedBashRules": ["Bash(git status *)", "Bash(pnpm test *)"]
    },
    "mock": { "scenario": "success" }
  },
  "verification": {
    "commands": [
      { "name": "test", "argv": ["pnpm", "test"], "timeoutMs": 600000, "required": true }
    ]
  },
  "execution": {
    "requireCleanWorkingTree": true,
    "stopOnUnverifiedTask": true,
    "capturePatch": true,
    "maximumPatchBytes": 10485760,
    "protectedPaths": []
  }
}
```

Validation is fail-closed and enforces the safety rules:

- commands are **argv arrays** — a shell string like `["pnpm test"]` is
  rejected outright, and no shell is ever invoked
- null bytes and path traversal are rejected
- `bypassPermissions` and `dangerously-skip-permissions` are rejected
  wherever they appear; there is no override
- an invalid config file refuses execution instead of degrading silently

Never commit API keys; SpecBridge stores no credentials of any kind.

## The mock runner

`mock` is fully offline and deterministic: identical input produces
identical output. Its configured `scenario` selects the behavior — including
deliberately bad behaviors (`malformed-output`, `protected-path`,
`modify-tasks-doc`, `timeout`, `claims-untested`, `resume-failure`, …) so
the safety layers around runners are testable end to end. CI runs entirely
on the mock runner plus a fake Claude CLI process fixture; it never needs a
real Claude installation or network access.

## Related

- [Claude Code runner](claude-code-runner.md)
- [Model-assisted authoring](model-assisted-authoring.md)
- [Task execution](task-execution.md)
- [Security model](security.md)
