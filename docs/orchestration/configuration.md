# Orchestration configuration

The `orchestration` block in `.specbridge/config.json`. Every field is
optional with a safe default, so **no existing configuration file needs to
change and no migration is required**.

The block is accepted in both the v1 and v2 configuration schemas, so a v1
workspace can configure orchestration without migrating first. The
configuration schema version is deliberately not bumped: this is an additive
optional block, exactly like the optional fields v0.5 added to the run record.

## Full shape, with defaults

```json
{
  "orchestration": {
    "enabled": true,
    "planning": {
      "mode": "review",
      "maxReplans": 2,
      "maxPlanSteps": 40,
      "maxPlanBytes": 65536
    },
    "execution": {
      "maxIterations": 12,
      "maxRepairCycles": 3,
      "maxNoProgressCycles": 2,
      "maxElapsedMs": 14400000
    },
    "retry": {
      "maxTransientRetries": 2,
      "baseBackoffMs": 1000,
      "maxBackoffMs": 30000
    },
    "clarification": {
      "maxRounds": 3,
      "maxQuestionsPerRound": 5,
      "maxQuestionBytes": 1024,
      "maxAnswerBytes": 4096
    },
    "history": {
      "maxEvents": 2000,
      "maxEventBytes": 8192,
      "defaultEventPageSize": 50
    }
  }
}
```

## What each setting does

| Setting | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | When false, orchestration tools refuse to start runs and say why. The direct `task_begin`/`task_complete` lifecycle is unaffected |
| `planning.mode` | `review` | `review` requires explicit plan confirmation before the first mutation; `auto` records a plan without requiring review; `disabled` requires no plan **and disables nothing else** |
| `planning.maxReplans` | 2 | Replans per run |
| `planning.maxPlanSteps` | 40 | Steps in one plan — a larger plan usually means the task should be split |
| `planning.maxPlanBytes` | 65536 | Serialized plan size |
| `execution.maxIterations` | 12 | Recorded observe/decide/act iterations |
| `execution.maxRepairCycles` | 3 | Repair cycles after verification failures |
| `execution.maxNoProgressCycles` | 2 | Materially identical cycles tolerated before replan or block |
| `execution.maxElapsedMs` | 4 h | Wall-clock budget, checked whenever a decision is requested |
| `retry.maxTransientRetries` | 2 | Bounded retries for safely-transient failures |
| `retry.baseBackoffMs` / `maxBackoffMs` | 1000 / 30000 | Deterministic exponential backoff, no jitter |
| `clarification.maxRounds` | 3 | Clarification rounds before the run blocks |
| `clarification.maxQuestionsPerRound` | 5 | Questions per round |
| `history.maxEvents` | 2000 | Append-only ceiling; reaching it stops the run rather than truncating history |
| `history.maxEventBytes` | 8192 | Per-event size; oversized events are refused, never trimmed |

## What you cannot configure here

By design there is no way to configure a command, a shell, a network
endpoint, a credential, an approval bypass, or a verification bypass. Every
value above can only make execution **stop sooner**. Raising a budget lets a
run go further; nothing here lets it skip a gate.

Trusted verification commands still come only from `verification.commands`,
as argv arrays — never from plan text, spec text, clarification text, or
repository content.

## Inspecting and validating

```bash
specbridge orchestrate policy show
```

```bash
specbridge orchestrate policy validate --json
```

`validate` exits non-zero only for a genuinely invalid configuration. It
*warns* — without failing — when a setting weakens the default posture, and
says exactly what remains enforced:

- `enabled: false` → the governed workflow will refuse to start runs.
- `planning.mode: "auto"` → plans are recorded but not reviewed before the
  first edit.
- `planning.mode: "disabled"` → no plan is required; approvals, evidence,
  verification, protected paths, and budgets all still apply.

## Policy changes and running runs

A run records a fingerprint of the policy it started under. If the
configuration changes mid-run, resume reports it and the run continues under
the budgets it was created with. Enforcing different limits than the ones a
plan was reviewed under would make the review meaningless — so the change is
surfaced instead of silently applied, and adopting it means starting a new
run.
