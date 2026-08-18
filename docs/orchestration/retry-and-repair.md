# Retry, repair, and replanning

Retries are decided by policy, not by an agent saying "let me try that
again". One pure function decides what happens after every observation, from
the failure category, the budgets, the counters, and the progress assessment.
An agent asking to retry gets exactly the answer the CLI would get.

## Failure taxonomy

Eighteen stable categories. Each defines retryability, repairability, replan
eligibility, clarification eligibility, whether execution must terminate, and
safe remediation.

| Category | Retry | Repair | Replan | Clarify | Terminal |
| --- | :-: | :-: | :-: | :-: | :-: |
| `TRANSIENT_TRANSPORT` | ✓ | | | | |
| `TRANSIENT_TOOL` | ✓ | | | | |
| `VERIFICATION_FAILURE` | | ✓ | ✓ | | |
| `IMPLEMENTATION_DEFECT` | | ✓ | ✓ | | |
| `AMBIGUITY` | | | | ✓ | |
| `BLOCKED_DEPENDENCY` | | | ✓ | ✓ | |
| `CAPABILITY_UNAVAILABLE` | | | ✓ | | |
| `AUTHENTICATION` | | | | | ✓ |
| `PERMISSION` | | | | | ✓ |
| `SAFETY_POLICY` | | | | | ✓ |
| `STALE_CONTEXT` | | | ✓ | | |
| `REPOSITORY_DIVERGED` | | | ✓ | | |
| `PROTECTED_PATH` | | | | | ✓ |
| `NO_PROGRESS` | | | ✓ | ✓ | |
| `BUDGET_EXHAUSTED` | | | | | ✓ |
| `CANCELLED` | | | | | ✓ |
| `INVALID_CONFIGURATION` | | | | | ✓ |
| `INTERNAL` | | | | | ✓ |

Exactly two categories are retryable, and both mean "the same idempotent
operation, again, bounded".

## The decision order

Evaluated in strict priority so the outcome is fully determined by the inputs:

1. **Cancellation** — absolute, before every budget and retry rule. Never
   restarted automatically.
2. **Terminal categories** — stop regardless of remaining budget.
3. **Hard budgets** (elapsed time, iterations) — checked *before* any
   continuation, so an exhausted run can never take "one more" step.
4. **Ambiguity** — clarify, never retry, never guess past.
5. **Bounded transient retry** — the only path that repeats the same thing.
6. **Stagnation** — replan if a budget remains, otherwise block.
7. **Repairable failures** — bounded repair cycles.
8. **Replannable failures** — bounded replans.
9. **Clarifiable failures** — ask.
10. Anything else classified — block.
11. No failure — verify when asserted ready, otherwise continue.

## Why a failing verifier is not retried

Rerunning a deterministic failure unchanged cannot make it pass. The loop is:

```text
observe failure
   ↓
classify
   ↓
inspect evidence
   ↓
repair implementation      ← the only step that can change the outcome
   ↓
fresh observation
   ↓
rerun trusted verifier
```

A repair cycle is tied to a concrete observed failure, the current task, the
current plan revision, the current Git baseline, and actual verifier evidence.
It is not a fresh unrelated attempt.

When the repair budget is exhausted (`execution.maxRepairCycles`, default 3):
the changes are preserved, the evidence is preserved, the blocker is reported,
and **the task stays incomplete**.

## Progress and stagnation

"Did anything change?" is answered from deterministic signals, not from
natural-language similarity between two agent summaries:

- verifier identity and exit code
- a **normalized failure fingerprint** — volatile substrings (absolute paths,
  durations, timestamps, pids, hex ids, line/column noise, ANSI codes) are
  masked before hashing, so the same failure hashes the same across machines
- a **diff fingerprint** over the changed-file set and content hashes
- the plan revision
- the action category

An observation with the same action category, plan revision, failure identity,
result, and tree as the previous one is *materially identical* — that is a
loop, whatever the agent believes it just did.

A **new plan revision always counts as new**: replanning is by definition a
change of approach, so it gets a fresh chance to make progress and the
stagnation counter resets.

When no-progress exceeds `execution.maxNoProgressCycles` (default 2):
replan if the replan budget remains and evidence justifies it; otherwise
block. All evidence is preserved, and completion is never claimed.

## Budgets

| Setting | Default |
| --- | --- |
| `execution.maxIterations` | 12 |
| `execution.maxRepairCycles` | 3 |
| `execution.maxNoProgressCycles` | 2 |
| `execution.maxElapsedMs` | 4 hours |
| `planning.maxReplans` | 2 |
| `retry.maxTransientRetries` | 2 |
| `clarification.maxRounds` | 3 |
| `history.maxEvents` | 2000 |

Every exhaustion produces an explicit outcome naming the budget. The run never
silently continues forever, and it never silently stops either.

Backoff for transient retries is deterministic exponential (`baseBackoffMs`
doubling, capped at `maxBackoffMs`) with no jitter, so behaviour is exactly
reproducible in tests.

## Provider fallback stays disabled

There is no automatic provider switching for task execution or resume. A
failed implementation attempt is never concealed by moving from Claude Code to
Codex, Gemini, or anything else. `CAPABILITY_UNAVAILABLE` says so in its
remediation.
