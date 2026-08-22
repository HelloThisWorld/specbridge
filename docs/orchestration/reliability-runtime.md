# Reliability, Eval & Recovery Runtime (vNext.6)

Every phase before this one answered the same question in a different way:
*can SpecBridge keep running?* vNext.1 made jobs survive their workers,
vNext.2 made them survive quota exhaustion, vNext.3 and vNext.4 gave the local
lane real execution, and vNext.5 gave a stalled job a paid way across an
outage.

vNext.6 answers a different question:

> Can SpecBridge stop a long-running agent from repeatedly doing the wrong
> thing — wasting quota, expanding errors, or declaring success without
> sufficient evidence?

The distinction matters because the two goals pull in opposite directions. A
runtime optimized purely for continuity will always find something to run
next. That is exactly how a week of prepaid quota disappears into forty
attempts at one task, each one confident, each one identical.

## The governing loop

```text
                        Task
                         |
                         v
                    Scheduler                  (vNext.2 / .4 / .5)
                         |
              Local / Subscription / API
                         |
                         v
                 ExecutionAttempt              (vNext.1)
                         |
                         v
                      Eval                     <- vNext.6
             +-----------+-----------+
             |                       |
           PASS                    FAIL
             |                       |
          complete                Diagnose
                                     |
                              FailureAssessment
                                     |
                              Progress / Loop
                                  Detection
                                     |
                               Budget Check
                                     |
                              RecoveryPlanner
                     +---------------+---------------+
                     |               |               |
                   repair          replan         escalate
                     |               |               |
                     +---------------+---------------+
                                     |
                                 checkpoint
                                     |
                               next Attempt
```

Two invariants hold at every arrow:

1. **No retry without a reasoned failure classification.** There is no path
   from "attempt failed" to "run it again" that does not pass through a
   structured `FailureAssessment`. The job state machine has never permitted
   `RUNNING → REPAIRING`; vNext.6 routes every governed recovery through the
   same gate.
2. **Repeated failure must change strategy, not consume more compute.** When
   loop detection proves the same experiment is about to run a third time, the
   planner refuses it.

And the direction of authority never reverses:

```text
Worker  ->  "retry me"              refused
Worker  ->  "spend more API"        refused
Worker  ->  "change the contract"   refused
Worker  ->  "mark task complete"    refused
```

Those are SpecBridge decisions. A worker may implement, inspect, test, propose
a diagnosis, propose a repair, and propose completion. It may not select the
recovery action, expand a budget, authorize spending, or declare a task done.

## Evaluation: deterministic first

```text
Level 0  EXECUTION_INTEGRITY   is this attempt trustworthy at all?
Level 1  REPOSITORY_INTEGRITY  what does Git actually say changed?
Level 2  BUILD_STATIC          compile / typecheck / lint / schema
Level 3  TESTS                 unit / integration / regression / contract
Level 4  ACCEPTANCE_CRITERIA   the approved contract's own criteria
Level 5  SEMANTIC_REVIEW       bounded judgment, only where 0-4 cannot decide
```

The order is the policy, and it is enforced by the shape of the code rather
than by discipline. `evaluateAttempt` computes the deterministic verdict
first; the semantic proposal is consulted only on an otherwise-passing
attempt. By the time a reviewer's opinion is read, a `FAIL` has already been
returned.

```text
tests fail + semantic reviewer says PASS   ->  FAIL
tests pass + semantic reviewer says FAIL   ->  FAIL
```

The asymmetry is deliberate: judgment may be conservative, never permissive.

Level 0 comes first because everything above it is conditional on it. If the
worker was not the assigned one, the baseline moved underneath the attempt, or
a protected path was touched, then the attempt's output is not evidence about
the implementation — it is a measurement taken with a broken instrument.

### Three verdicts, and the third is load-bearing

| Verdict | Meaning |
| --- | --- |
| `PASS` | every required check ran and passed |
| `FAIL` | a required check failed on evidence we trust |
| `INCONCLUSIVE` | a required check could not run at all |

`INCONCLUSIVE` is not a soft `FAIL`. "We could not tell" and "the code is
wrong" demand opposite recoveries: the first repairs infrastructure, the
second repairs code. Collapsing them is what makes a system rewrite correct
code for an hour because the test runner was down.

A test suite that could not start is `UNAVAILABLE`. A verifier that timed out
is `TIMED_OUT`. Neither is ever silently promoted to `PASSED`.

### Acceptance criteria are not tests

Tests encode what someone remembered to assert. Acceptance criteria encode
what was actually approved. A change can compile, pass every test, and violate
approved intent — that is a **failed** task, and Level 4 makes the verdict
deterministic rather than a matter of opinion.

Criteria come from state that was already approved: active product-contract
invariants with machine-checkable guard patterns, and criteria pinned on the
task's canonical checkpoint. A criterion an agent could write for itself would
be a task grading its own homework.

Criteria with no structural form are reported `NOT_RUN` and surfaced as
unchecked. They are never assumed to hold — but "unchecked and visible" is
also not "verified", and the CLI says so.

## Failure assessment: what kind, and whose fault

The existing failure taxonomy is unchanged. vNext.6 adds an **orthogonal**
question beside it:

```text
FailureCategory   what went wrong        (existing, stable, unchanged)
FailureSource     whose fault it was     (new)
```

Neither is derived from the other. A `VERIFICATION_FAILURE` is normally an
`IMPLEMENTATION` source — the code is wrong and the verifier caught it. The
identical category with a crashed test runner is a
`VERIFICATION_INFRASTRUCTURE` source, and the two demand opposite responses.

The distinction the source exists for:

```text
EXECUTION_INFRASTRUCTURE   a crashed harness proves nothing about the task
IMPLEMENTATION             the model did the work badly
```

Only the second makes "use a stronger model" a rational response. Escalating
to answer a crashed process spends prepaid quota on a question nobody asked,
so `NON_INTELLIGENCE_FAILURE_SOURCES` is consulted before any escalation may
even be considered.

Assessments carry a `basis` rather than a confidence score — deterministic
evidence, a provider signal, attempt history, or a model diagnosis. A number a
model invented is not a safety mechanism; where the conclusion came from is
checkable.

## Execution health: is this task stuck?

```text
HEALTHY      attempts are changing the world in different ways
DEGRADED     failing, but each attempt is materially different
STALLED      repeated attempts produce the same diff AND the same failure
OSCILLATING  attempts alternate between states that already failed
RUNAWAY      an attempt exceeded its own bounds and was stopped
```

`DEGRADED` exists so that "failing" and "stuck" are not the same word. A task
can fail three times productively, each attempt eliminating a real hypothesis.
`STALLED` and `OSCILLATING` are the states where more of the same compute is
provably wasted, and they are the only ones that force a strategy change.

Every signal is arithmetic over two hashes and a strategy key:

- `failureFingerprint` — category, source, exit code, and normalized output
  through an explicit, auditable mask list
- `diffFingerprint` — changed paths plus content identity, sorted
- `strategyKey` — lane, execution mode, plan revision, fresh-context flag

None of it reads agent prose. A worker cannot make a repetition look novel by
describing it differently, which is the entire reason the signals are hashes.

### Oscillation is not the same as repetition

```text
attempt 1   diff A   failure F
attempt 2   diff B   failure F        <- looks like progress
attempt 3   diff A   failure F        <- it was a cycle
```

Comparing adjacent pairs sees three different attempts. Comparing a bounded
window sees a state revisited with the failure unchanged — a sequence with no
fixed point. A revisit while the failure *changes* is not counted: that is new
information.

### RUNAWAY stops the attempt

Per-attempt ceilings on tool calls, command runs, test loops, and context
growth. Exceeding one outranks every other health state: the attempt is
stopped, checkpointed, assessed, and recovered from — normally by discarding
the session and rebuilding context, not by asking a bigger model the same
question.

Metrics the runtime did not report stay `null` and never fire. Stopping an
attempt for the *absence* of evidence would make every quiet runner
permanently suspect.

## Budgets: unified by reading, not by re-counting

There is no `ReliabilityBudget`. Every number is read from the component that
already owns it:

| Bound | Owner |
| --- | --- |
| attempts, repairs, replans, retries, no-progress, wall clock | `jobs.budgets` |
| shared LOCAL attempts | `jobs.scheduler.maxLocalAttempts` (vNext.4) |
| API dollars | `ApiBudgetController` (vNext.5) |
| subscription quota | `QuotaManager` (vNext.2) |

A second attempt counter would diverge the first time one code path updated it
and another forgot, and would eventually disagree about whether a job may keep
spending money. So the hierarchy — job → task → attempt — is expressed by
projection:

```text
buildBudgetView(...)  ->  BudgetView  ->  snapshotBudget(...)  ->  decision
```

What reliability *does* add is the soft/hard distinction. Every existing bound
is hard: it stops work. `softBudgetPressure` answers "should we think now?",
so a task at its last repair reconsiders its approach rather than discovering
the wall by hitting it.

The `reliability` policy block is correspondingly small — only genuinely new
signals appear in it, and the mapping onto existing bounds is documented in
its own doc comment.

## Recovery: one pure function

```text
planRecovery(
  FailureAssessment, EvaluationResult, ExecutionHealth,
  BudgetView, ReliabilityPolicy, history, resources
) -> RecoveryPlan
```

No clock it was not handed, no I/O, no model, no state between calls. Given
the same durable inputs it returns the same action, forever — which is what
makes recovery testable, auditable, and impossible for the agent it governs to
argue with.

The evaluation order **is** the argument:

1. hard boundaries (safety, permission, authentication)
2. hard budgets — before anything that could spend
3. human authority — before any automatic guess
4. broken measuring equipment, before broken code
5. bounded infrastructure retries
6. bounded transient retries
7. runaway and context degradation → rebuild context
8. the paid lane, held to a stricter standard than any other
9. stuck (`STALLED` / `OSCILLATING`) → change strategy
10. contract mismatch → replan, not repair
11. LOCAL mode change, before spending prepaid quota
12. bounded LOCAL intelligence spent → escalate
13. bounded repair
14. replan
15. escalation
16. stop honestly

### Actions

| Action | When |
| --- | --- |
| `RETRY_TRANSIENT` | genuinely transient or infrastructure conditions, bounded |
| `REPAIR` | goal and plan valid, implementation localized and wrong |
| `RESTART_FRESH_CONTEXT` | session polluted, runaway, or context over threshold |
| `RETRY_DIFFERENT_LOCAL_MODE` | `DIRECT_MODEL` failed for want of repository tools |
| `REPLAN` | strategy invalid, repeated repair failed, stuck, contract mismatch |
| `ESCALATE_INTELLIGENCE` | bounded local intelligence genuinely spent |
| `ESCALATE_LANE` | a different economic lane is required |
| `WAIT_FOR_RESOURCE` | capacity returns soon, or paying is not authorized |
| `REQUEST_HUMAN_DECISION` | contract conflict, ambiguity, budget expansion |
| `BLOCK` / `FAIL_TASK` | bounded recovery exhausted |

A task that ends `BLOCKED` with a durable explanation of what was tried and
why it failed is a **successful governance outcome**. The failure mode this
phase exists to prevent is not "a task did not get done" — it is "a task did
not get done, expensively, repeatedly, and without anyone learning why".

### Escalation is a request, never an authorization

`ESCALATE_LANE` produces a *requirement*: strong remote continuation is
needed. It authorizes nothing. vNext.5 spend authorization, the API budget
reservation, and the gap-bridge planner each keep an independent veto, and the
decision's own remediation text says so.

When prepaid capacity is unavailable and paid execution is not authorized (or
its budget refuses), the answer is to wait or to ask a human — never to spend.
Defaults may cost a wait; they may never cost money.

### The paid lane is held to a stricter standard

A deterministic failure on `lane = API` has already been paid for once.
Buying the identical experiment again is the most expensive mistake available,
so `allowApiDeterministicRetry` defaults to `false` and the strategy must
change instead: wait for prepaid capacity, replan, or ask.

A `REPLAN` decision deliberately records **no lane at all**. Recovery decides
what kind of attempt is required; the economic scheduler decides where and
when it runs, fresh from live telemetry. Carrying the failed lane forward
would quietly turn a recovery record into a placement — and on the paid lane
it would read as authorization to spend again.

### A diagnosis may narrow, never widen

The persisted decision acts as a **ceiling** on what the model diagnosis may
do:

```text
diagnoser moves repair -> replan     allowed   (toward caution)
diagnoser moves replan -> repair     refused   (away from caution)
```

The second half is the invariant: a task the loop detector has proved stalled
cannot talk its way into another identical attempt. The first half is equally
deliberate — a diagnoser inspects the repository and can discover that the
plan's assumptions were invalid, which is genuinely new information the
failure output alone could not carry. Ignoring it would not be caution.

## Durability

```text
.specbridge/jobs/<jobId>/reliability/
  evaluations/<evaluationId>.json    durable verdicts on attempts
  assessments/<assessmentId>.json    durable failure assessments
  decisions/<decisionId>.json        durable recovery decisions
  tasks/<nodeId>.json                bounded per-task health + history
```

The decision is written **before** it is returned, so a crash between deciding
and acting leaves the reasoning on disk. A restarted process finds it, marks
it applied, and continues it — rather than re-deriving a transition from
whatever the world looks like now and silently choosing differently.

Nothing recovery-critical lives in a conversation, so compaction cannot reach
any of it. Contracts and acceptance criteria are re-read from the canonical
checkpoint's pinned context; fingerprints, verdicts, and decisions are
separate durable records.

## Observability

Semantic lifecycle events, reusing existing ones rather than duplicating them
under reliability-flavoured names:

```text
evaluation_started / _passed / _failed / _inconclusive
semantic_review_completed
failure_assessed
execution_stalled / _oscillating / _runaway
recovery_decided
fresh_context_selected
local_mode_recovery_selected
lane_escalation_requested
resource_wait_selected
recovery_budget_exhausted
task_blocked_after_recovery
```

### The CLI

```bash
specbridge orchestrate explain-node <jobId> <nodeId>
```

Answers, in one read-only report:

- Why is this task not complete?
- Which checks failed?
- What is its current execution health?
- What failure fingerprint is repeating?
- How many repairs / retries / replans remain?
- Why was the current recovery action selected?
- How much time, quota, and API cost went into failed attempts?
- What would unblock it?

`--json` produces the same content machine-readably.

### The ledger

`ExecutionLedgerEntry` gains additive reliability attribution: evaluation
status, failure source, failure fingerprint, execution health, recovery action
and reason code, and the strategy dimension that changed. `summarizeExecutionLedger`
aggregates the cost of failure — failed attempts, and the wall time, tokens,
and dollars they consumed without producing a verified completion.

These are the raw facts a later adaptive scheduler needs. They are collected
deliberately un-aggregated: an analytics store that decided in advance which
questions were worth asking would foreclose the ones that turn out to matter.

## Backward compatibility

`reliability.enabled` defaults to `true`, and every field it adds is additive.
With it set to `false`, evaluation records are still **written** — governance
is off, observability is not — and the pre-vNext.6 decision cascade governs
transitions exactly as before.

Existing workspaces stay valid. An attempt the reliability layer did not
govern carries `null` attribution in the ledger rather than a fabricated
verdict.

## Configuration

Under `orchestration.jobs.reliability` in `.specbridge/config.json`:

```json
{
  "orchestration": {
    "jobs": {
      "reliability": {
        "enabled": true,
        "sameFailureThreshold": 2,
        "oscillationThreshold": 3,
        "maxFreshContextRestarts": 1,
        "freshContextRecoveryRatio": 0.85,
        "maxInfrastructureRetries": 2,
        "maxToolCallsPerAttempt": 400,
        "maxCommandRunsPerAttempt": 200,
        "maxTestLoopsPerAttempt": 12,
        "maxAttemptWallTimeMs": null,
        "maxContextUsageRatio": 0.95,
        "semanticReview": "auto",
        "allowApiDeterministicRetry": false,
        "gateDependentsOnEvaluation": true,
        "maxRecordsPerJob": 1000
      }
    }
  }
}
```

| Setting | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | When false, records are still written but the recovery planner does not govern transitions — pre-vNext.6 behavior exactly |
| `sameFailureThreshold` | 2 | Occurrences of ONE failure fingerprint in the window that count as repeated failure |
| `oscillationThreshold` | 3 | Alternating distinct repository states that count as `OSCILLATING` |
| `maxFreshContextRestarts` | 1 | Bounded fresh-context restarts per task |
| `freshContextRecoveryRatio` | 0.85 | Context occupancy at which recovery rebuilds context rather than repairing code |
| `maxInfrastructureRetries` | 2 | Bounded retries for failures that prove nothing about the task |
| `maxToolCallsPerAttempt` | 400 | Tool calls before an attempt is `RUNAWAY`. `null` disables |
| `maxCommandRunsPerAttempt` | 200 | Command runs before `RUNAWAY`. `null` disables |
| `maxTestLoopsPerAttempt` | 12 | Test/verify loops inside one attempt before `RUNAWAY`. `null` disables |
| `maxAttemptWallTimeMs` | `null` | Per-attempt wall clock. `null` defers to the lane's own bound |
| `maxContextUsageRatio` | 0.95 | Context occupancy that counts as unsafe growth within one attempt |
| `semanticReview` | `auto` | `auto` reviews high-risk work and unchecked criteria; `always`; `disabled` |
| `allowApiDeterministicRetry` | `false` | Whether a paid attempt that failed deterministically may be retried on the API lane |
| `gateDependentsOnEvaluation` | `true` | Whether dependent tasks wait for a predecessor's evaluation to `PASS` |
| `maxRecordsPerJob` | 1000 | Retained evaluation/assessment/decision records per job |

Deliberately **absent** from this block: attempt, repair, replan, transient-retry,
no-progress, and wall-clock bounds. Those already exist in
`orchestration.jobs.budgets`, the shared LOCAL bound in
`orchestration.jobs.scheduler.maxLocalAttempts`, and the paid ceiling in
`orchestration.jobs.scheduler.api.budget`. Duplicating a number under a second
name is how a system ends up enforcing whichever one the last author happened
to read.

Nothing here can weaken a safety boundary. There is no setting that bypasses
approvals, verification, protected paths, spend authorization, or the
evidence-based completion gate.

## Extension points

**vNext.7 Context Efficiency.** `RESTART_FRESH_CONTEXT` and the
`CONTEXT_DEGRADED` / `CONTEXT_THRESHOLD_REACHED` reason codes already route
context-shaped failures to context-shaped recovery. Attempt metrics record
context occupancy before and after; `RUNAWAY` already fires on unsafe growth.
A context-efficiency phase has a signal, a trigger, and a measurement in
place.

**vNext.8 Adaptive Scheduler.** Every fact needed to compute attempts per
successful task, failed-token and failed-quota ratios, API dollars spent on
attempts that never verified, time to recovery, and replan success rate is now
on the ledger. `planRecovery` is a pure function of durable state, so an
adaptive layer can be evaluated against recorded history before it is ever
allowed to route anything.

Neither is implemented here. Collecting the evidence first, and routing on it
later, is the same order this phase applies to everything else.

## See also

- [Survival runtime](survival-runtime.md) — attempts, checkpoints, context
- [Quota scheduling](quota-scheduling.md) — lanes, modes, admission
- [Local agentic runtime](local-agentic-runtime.md) — LOCAL execution modes
- [API gap bridge](api-gap-bridge.md) — paid continuity and spend authorization
- [Retry and repair](retry-and-repair.md) — the v1.1 failure taxonomy
- [Threat model](../security/threat-model.md) — section 13
