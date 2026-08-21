# API Gap Bridge (vNext.5)

A long-horizon SpecBridge job runs for days. Claude Max quota does not: the
rolling five-hour window empties, and once a week the weekly window empties
too — sometimes for a day and a half. vNext.2 handled that by **waiting**,
which is correct and cheap and occasionally useless: a critical task that
blocks the whole job does not become less blocking because waiting is free.

vNext.5 adds a third economic lane whose *only* automatic purpose is to carry
a job across that gap.

```text
LOCAL           zero-marginal-cost compute
      ↓
SUBSCRIPTION    prepaid strong intelligence
      ↓
API             PAYG continuity bridge
```

The API lane is **not** a third equal-priority lane, and the ordering above is
enforced by the call graph rather than by convention. Three invariants govern
everything below:

1. **Never pay API cost for work Local can reliably complete or Max can
   reasonably execute.**
2. **When Max is unavailable, keep doing useful Local work** before — or
   alongside — considering paid work.
3. **No automatic paid execution without explicit spend authorization and
   bounded budget admission.**

The default configuration makes no paid call. Upgrading a vNext.4 workspace
changes nothing about how it spends money, because it still cannot.

## Where the planner sits

```text
                         Task
                          |
                          v
                   Local Suitability
                          |
             +------------+-------------+
             |                          |
        Local capable               not capable
             |                          |
             v                          v
          LOCAL                Subscription Admission
     +-------+------+                  |
     |              |           +------+------+
  DIRECT         HARNESS        |             |
                               safe        unavailable
                                |             |
                                v             v
                         SUBSCRIPTION    Gap Bridge Planner
                                        +------+------+
                                        |      |      |
                                      DEFER APPROVE  API
                                                     |
                                                     v
                                            API Budget Guard
                                                     |
                                                     v
                                            DeepSeek Harness
                                                     |
                                                     v
                                              Remote Model
```

`decideLane` — the vNext.2 function that chooses between LOCAL, SUBSCRIPTION,
and DEFER — is **unchanged by this phase**. It has no way to name the API
lane, so it structurally cannot evolve into "strong task → compare Claude and
the API and pick the better one". The gap-bridge planner runs strictly
*after* it, and only over a routing it already refused for a
subscription-capacity reason.

That is the difference between a continuity bridge and a default lane, and it
is deliberately a property of the architecture rather than of a policy flag.

## Four things that stay orthogonal

vNext.4 established that lane, mode, harness, and locality are different
questions. vNext.5 adds a fifth and keeps all five separate:

| Concept | Question it answers | Values |
| --- | --- | --- |
| **Economic lane** | Who pays? | `LOCAL`, `SUBSCRIPTION`, `API` |
| **Execution mode** | How is the work performed? | `DIRECT_MODEL`, `HARNESS` |
| **Harness** | Which tool loop ran it? | a runner profile |
| **Provider / model** | Which intelligence answered? | configured strings |
| **Compute locality** | Where did inference run? | `LOCAL`, `REMOTE`, `UNKNOWN` |

A real record looks like this:

```text
lane:             API
executionMode:    HARNESS
runner:           deepseek-harness
computeLocality:  REMOTE
provider:         configured-provider
model:            configured-model
```

There is deliberately **no** `API_DSH`, `REMOTE_GPT`, or `PAID_DEEPSEEK`
value anywhere. Those compounds would make three independent questions —
*was this paid? which harness ran it? which model answered?* — unanswerable
separately, which is exactly what an economic audit needs to answer.

## Configuration

Everything lives under `orchestration.jobs.scheduler.api`, and every default
is the non-spending one.

```jsonc
{
  "orchestration": {
    "jobs": {
      "scheduler": {
        "api": {
          // DISABLED (default) | MANUAL | AUTO_BOUNDED
          "spendMode": "DISABLED",
          // The harness profile bound to the paid lane. Null by default:
          // a remote profile existing in runnerProfiles is NOT a fallback.
          "harnessProfile": null,
          "maxApiWallTimeMs": 1800000,
          // Operator-supplied. SpecBridge never fetches prices at runtime
          // and ships no price table of its own.
          "pricing": {
            "inputCostPerMillion": 0,
            "outputCostPerMillion": 0,
            "cachedInputCostPerMillion": null,
            "currency": "USD",
            "source": "where you got these numbers, and when"
          },
          "budget": {
            "maxCostPerJobUsd": null,
            "maxCostPerTaskUsd": null,
            "maxCostPerAttemptUsd": null,
            "maxApiAttemptsPerTask": 2,
            "maxApiAttemptsPerJob": 20
          },
          "gap": {
            "shortGapDeferMs": 1200000,
            "minGapForAutoBoundedMs": 1800000,
            "minDelaySensitivity": "HIGH",
            "materialGapMs": 3600000,
            "costSafetyMultiplier": 1.5,
            "wastefulStartRatio": 0.25,
            "unknownResetBehavior": "MANUAL",
            "strongTasksOnly": true,
            "preferReadyLocalBacklog": true,
            "approvalTtlMs": 86400000
          },
          "allowUnverifiedLocality": false
        }
      }
    }
  }
}
```

### Three independent controls

Paid execution requires **all three**, and they are separate on purpose:

1. an API **profile** that exists, is enabled, is complete, has an attested
   write boundary, and verifies as **REMOTE** compute;
2. an explicit **binding** of that profile to the API lane;
3. explicit **spend authorization** (`MANUAL` or `AUTO_BOUNDED`).

Installing a harness grants nothing. Binding a profile grants nothing.
Authorizing spending without a valid binding grants nothing.

## Spend modes

### `DISABLED` (default)

```text
Local cannot handle it
Max unavailable
API binding exists
    ↓
do NOT spend
    ↓
the task remains durably pending
```

The scheduler still records *why*: a decision with reason code
`API_DISABLED`, carrying the gap, its expected duration, and the delay
sensitivity. A user who configured an API lane and sees a job waiting gets an
answer, not a mystery — and still no charge.

### `MANUAL`

The planner may conclude that bridging would preserve continuity. It does not
spend. It records a durable, **bounded** approval request explaining:

- why Local cannot continue this task,
- why Subscription is unavailable and for how long,
- the estimated cost and the remaining budget,
- how delay-sensitive the task is, and why.

A human decides through the CLI:

```bash
specbridge orchestrate api-approve <jobId> <approvalId> --max-cost 2.50 --by you
```

An approval is scoped to **one task version, one profile, one maximum cost,
and an expiry**. It is single-use. SpecBridge never asks "Allow API?", because
a yes to that question would authorize unbounded future spending.

### `AUTO_BOUNDED`

Automatic paid execution, permitted only when **every** condition passes:

```text
explicit AUTO_BOUNDED authorization
AND a valid, verified-REMOTE API binding
AND the task is API-eligible (strong work, not mechanical work)
AND Local cannot reliably finish it
AND the subscription gap is material
AND delaying it is materially harmful
AND a cost estimate exists with sufficient confidence
AND budget reservation succeeds
```

If any input is unknown, SpecBridge does not silently spend. It fails toward
`MANUAL` or `DEFER` according to policy.

## What counts as a gap

Not every subscription defer is API-worthy, so the *cause* of the gap is
modeled separately from its *duration*:

| Gap reason | Typical duration | Usually |
| --- | --- | --- |
| `FIVE_HOUR_EXHAUSTED` | minutes to hours | wait, unless long and critical |
| `WEEKLY_EXHAUSTED` | hours to days | the scenario this phase exists for |
| `PRE_RESET_BURN_UNSAFE` | until the next reset | wait — capacity returns soon |
| `SUBSCRIPTION_TEMPORARILY_UNAVAILABLE` | policy-dependent | wait |
| `SUBSCRIPTION_WORKER_UNAVAILABLE` | never resets | a configuration gap |

Local escalations, context-compaction refusals, and routing decisions are
**not** gaps and never reach the planner.

### Duration is first-class

`SubscriptionGapForecast` carries the reason, the expected return time, the
milliseconds until it, and a confidence. Nothing is fabricated: with no
observed reset timestamp the duration is `null` and confidence is `UNKNOWN` —
and unknown availability makes `AUTO_BOUNDED` **more** cautious, escalating to
a human (default) or continuing to wait, never assuming the outage is long
enough to be worth paying for.

## Delay sensitivity

The planner needs to know whether waiting actually costs anything. It asks the
work graph, not a model:

| Level | Meaning |
| --- | --- |
| `HIGH` | the job is effectively blocked on this task |
| `MEDIUM` | waiting costs progress, but the job is not stalled |
| `LOW` | other work is ready; nothing waits on this task |

Derived from blocked dependents, critical-path membership, ready alternatives,
and the ready **local** backlog. A model asked "is this urgent?" will say yes,
and it would be spending someone else's money to say it.

### Useful work beats paid bridging

If Max is out for thirty minutes and five local tasks are ready, SpecBridge
runs the local tasks. The objective is a productive **job**, not one blocked
task executing every second. The documented exception is the critical path: a
strong task that blocks the whole job may be bridged even while peripheral
local work remains.

Ready-node selection encodes the same preference — a free or prepaid runnable
task is always chosen ahead of an API-bridged one in the same pass.

## Cost estimation

Automatic spend must know what it is approximately authorizing.

- Token expectations come from the existing `WorkloadProfiler`, which now
  carries `expectedInputTokens` / `expectedOutputTokens` with an honest basis
  (`heuristic` until enough comparable ledger history exists).
- Money comes from the **operator's** price table. SpecBridge does not fetch
  provider prices at runtime and does not ship speculative current prices — a
  hard-coded table would quietly become a lie in the one module that
  authorizes spending.
- Budget admission compares a **safe** figure: the mean estimate times
  `costSafetyMultiplier`. A later phase can replace the multiplier with a
  measured P90 without any caller changing.

**Unknown cost is never zero.** With no pricing, or no estimable token usage,
`estimatedCostUsd` is `null` and automatic spend is refused with reason code
`API_COST_UNKNOWN`.

### Estimated versus observed

The ledger keeps them separate and names how each was determined:

| Cost source | Meaning |
| --- | --- |
| `PROVIDER_REPORTED` | the provider stated a monetary cost |
| `COMPUTED_FROM_USAGE` | actual tokens × the configured price table |
| `ESTIMATED_PRE_DISPATCH` | a forecast made before the attempt ran |
| `UNKNOWN` | the attempt's real usage is not knowable |

An estimate is never overwritten by an invented actual, and `UNKNOWN` is never
rendered as `$0`.

## Budget: a guardrail, not telemetry

```text
estimate
    ↓
reserve      (atomic, under an exclusive lock, re-checked against fresh state)
    ↓
dispatch
    ↓
reconcile    (commit at the observed figure, or hold at UNKNOWN)
```

An attempt whose safe estimate exceeds any configured ceiling is **not
dispatched**. Reservation happens before the attempt record exists, so a
refusal has nothing to unwind. Two tasks looking at the same remaining
`$10` and each needing `$7` cannot both proceed.

### Crash integrity

A process that dies mid-attempt leaves a `RESERVED` hold. Resume moves it to
`UNKNOWN`, which **keeps it charged against the budget**. This is deliberately
the pessimistic direction: SpecBridge cannot know whether the provider was
billed before the crash, and releasing a hold that may already have been spent
would let a job exceed its budget by crashing.

A corrupt budget file is refused loudly rather than read as an empty budget.

### What is *not* claimed

The DSH/provider stack does not expose real-time incremental usage, so
SpecBridge **cannot** stop an attempt mid-run at a cost threshold, and does not
pretend to. What it does instead:

- a conservative preflight estimate,
- a budget reservation before dispatch,
- a bounded wall-clock ceiling on the attempt,
- bounded attempt counts per task and per job,
- post-run reconciliation.

If incremental usage becomes observable later, enforcement can tighten without
any of the above changing.

## Execution

Paid agentic work reuses the vNext.3 `DeepSeekHarnessRunner` unchanged:

```text
SpecBridge
    ↓
API ExecutionAttempt
    ↓
DeepSeekHarnessRunner
    ↓
DSH remote/PAYG profile
    ↓
agentic work
    ↓
SpecBridge Evidence
```

There is no `ApiAgentLoop`, no `ApiShellRuntime`, no `ApiFileTools`, and no
second harness dependency. A separate paid execution path would be a second
place for "done" to be decided.

### Checkpoint before the handoff

Before a paid attempt starts, SpecBridge writes a `handoff` checkpoint
carrying forward the task contract, decisions already made, approaches already
ruled out, and known test state. The remote session has never seen the
subscription conversation that preceded it, and it must not need to. Replaying
a previous Claude conversation is never required.

The harness then receives the same lean bootstrap the local harness gets — the
canonical state plus pointers — and explores the repository itself.

### Completion is still only a claim

A paid model saying "done" carries exactly the authority a local model's claim
does, which is none. Git state, protected paths, and the trusted verification
commands decide. This is not weakened because the model is stronger or more
expensive.

## When Max comes back mid-attempt

```text
17:45  Max exhausted, API task starts
18:20  Max resets — the API task is 70% done
```

**The attempt is not killed.** Killing it would waste paid tokens, the context
it built, the work it performed, and the handoff that set it up. The unit of
placement is one atomic task attempt, not one model turn.

Once it finishes, the *next* strong task routes back to the subscription lane
through the ordinary scheduler — an `api_next_task_returned_to_subscription`
event records it. A provider that succeeded once never becomes sticky.

An active paid attempt is still cancelled for: a budget hard stop, user
cancellation, runaway detection, a security issue, provider failure, or an
invalidated task. Max becoming available is not on that list.

## Diagnostics

```bash
specbridge orchestrate scheduler <jobId>
specbridge orchestrate scheduler <jobId> --json
```

reports, alongside the vNext.2/vNext.4 sections:

- whether the API lane can spend at all, and in which mode;
- the bound profile, its runner, provider, model, and **verified locality**;
- whether pricing is configured (and a plain warning when it is not);
- reserved, committed, unknown, and remaining budget;
- pending approval requests and the command to decide them;
- for each waiting ready task, **why it is not bridging** — the gap, its
  duration, the delay sensitivity, and the estimated cost.

Human spend decisions live only in the CLI:

```bash
specbridge orchestrate api-approve <jobId> <approvalId> [--max-cost N] [--note ...] [--by ...]
specbridge orchestrate api-deny    <jobId> <approvalId> [--note ...] [--by ...]
```

No MCP tool, no agent-reachable API, and no model output can approve spending.

## Records

`SchedulingDecision` gains an `apiBridge` block, present on every decision the
planner touched — including the many that declined to spend. From one record
you can answer: why API was or was not selected, why Local was not enough, why
Subscription was not used, how long the gap was expected to last, whether the
task was critical, which spend mode applied, what it was estimated to cost,
what budget remained, and which profile would have run it.

`ExecutionLedger` entries gain `apiSpendMode`, `gapReason`,
`subscriptionAvailableAt`, `estimatedGapDurationMs`, `costSource`,
`pricingProfile`, `apiBudgetReservationId`, `apiApprovalId`,
`delaySensitivity`, and the separate `estimatedCostUsd` / `reservedCostUsd` /
`reconciledCostUsd` metrics. Missing values stay `null`.

That is enough for later analysis — cost per successful task, cost by task
type, bridge success rate, money spent versus subscription wait avoided —
without a second analytics database. This phase deliberately implements none
of those calculations.

## Backward compatibility

With no API configuration:

- behavior is exactly vNext.4;
- no `api_*` event is emitted and no planner runs;
- strong work still waits when Max is unavailable;
- `LOCAL`, `SUBSCRIPTION`, `HARVEST`, cross-reset admission, and
  `DIRECT_MODEL` / `HARNESS` semantics are unchanged.

No paid call can appear because the binary was upgraded.

## Explicit non-goals

Not implemented, and not accidentally reachable: API as a normal
equal-priority strong lane; best-model or tournament routing; automatic
provider price discovery; runtime price fetching; a billing or invoicing
system; ML cost prediction; self-learning provider selection; a second generic
harness framework.

## See also

- [Quota-aware scheduling (vNext.2)](quota-scheduling.md)
- [Local agentic runtime (vNext.4)](local-agentic-runtime.md)
- [DeepSeek Harness runner](../deepseek-harness-runner.md)
- [Threat model](../security/threat-model.md) — section 12
