# Quota-Aware Scheduling (vNext.2 — Free & Prepaid Optimizer)

vNext.2 turns the job runtime into an intelligent scheduler over two compute
resources with entirely different economics:

| Lane | Resource | Economics |
| --- | --- | --- |
| `LOCAL` | A locally served model (the managed llama.cpp integration) | Effectively zero marginal monetary cost; consumes no subscription quota; limited intelligence |
| `SUBSCRIPTION` | The Claude Max subscription worker | **Prepaid**; the primary strong-intelligence engine; limited by rolling five-hour and weekly quota windows; unused window capacity **expires at reset** |

Since vNext.4 the `LOCAL` lane has two **execution modes** — a bounded
one-shot request to the local model, or a bounded agentic run inside a
verified-local harness. That is a mode, not a lane: the economics, the shared
attempt budget, and the evidence pipeline are identical, and the lane decision
below is made *before* (and independently of) the mode. See
[Local agentic runtime](local-agentic-runtime.md).

vNext.5 adds an `API` lane (pay-as-you-go continuity when the subscription is
unavailable) — see [API gap bridge](api-gap-bridge.md). It is deliberately
**not** a third equal-priority lane, and the vNext.2 behavior described here
is unchanged by it: `decideLane` still knows only `LOCAL`, `SUBSCRIPTION`, and
`DEFER`. When the subscription lane is exhausted and local execution cannot
handle a task, the task still remains durably pending with a recorded
scheduling reason, and paid execution is considered only afterwards, only for
a material gap, and only when spending has been explicitly authorized and
budgeted. With no API configuration nothing about this document changes.

The governing policy:

> Use local compute for work it can reliably perform. Use Claude Max as the
> primary strong-intelligence engine. Do not preserve Max capacity that is
> about to expire, and do not exhaust it so early that critical strong work
> hits an avoidable dead period.

The scheduler reasons about the economic **lane** first, then the concrete
provider — nothing branches on a model name.

## Local-first policy

Every candidate task gets a deterministic local-suitability class
(`scheduling/suitability.ts` — documented keyword tables plus the
deterministic complexity class; no model in the loop):

| Class | Meaning | Routing |
| --- | --- | --- |
| `LOCAL_SAFE` | Summarization, ranking, extraction, log processing, reporting | Local lane, in every scheduler mode |
| `LOCAL_TRY` | Small verifiable code work (validation helpers, DTOs, renames, simple tests, docs) | Local lane **first**, in every scheduler mode |
| `STRONG_REQUIRED` | Everything else — architecture, cross-module, security, MEDIUM/HIGH complexity | Subscription lane via admission |

The load-bearing criterion for `LOCAL_TRY` is **verifiability, not perceived
difficulty**: an imperfect local implementation is acceptable exactly when
compile/tests catch imperfection cheaply. Without trusted verification
commands, code work never classifies `LOCAL_TRY`.

### Local execution

The local model is a native model endpoint, not an agent: it has no tools,
no shell, and never touches the repository. Local task execution
(`scheduling/local-execution.ts`) is SpecBridge-driven:

```text
bounded packet (task context)
        ↓
one structured response: complete replacement file contents, or ESCALATE
        ↓
SpecBridge validates paths/bounds and applies the edits
        ↓
the EXISTING interactive evidence pipeline verifies:
lock → Git snapshots → trusted verification → verified-only completion
```

A local attempt is an ordinary durable ExecutionAttempt on the `LOCAL` lane:
same Job/Task/Attempt semantics, same checkpoints, same ledger, same
failure→diagnosis→repair machinery as any other dispatch.

### Bounded local retries

Local compute is cheap; wall time is not. Local execution attempts are
bounded (`scheduler.maxLocalAttempts`, default 2):

```text
local attempt #1 → deterministic verification → FAIL
        ↓ diagnosis (local, cheap)
local repair #2  → deterministic verification → still FAIL
        ↓
LOCAL_ESCALATION_REQUIRED: the next dispatch routes to the subscription
lane, with a sticky escalation so the node never returns to local execution
```

A local model may also decline (`ESCALATE` in its own output) — that
escalates immediately with the reason preserved. Failed local attempts
remain visible in the attempt history and the ledger forever.

Since vNext.4 one intermediate step can come first: when the direct attempt
failed for lack of *repository knowledge* and a verified-local harness is
bound, the remaining budget continues on the harness path
(`LOCAL → LOCAL`, no subscription quota) before any strong escalation. The
budget above is unchanged — it counts local attempts, not local modes.

### Local preprocessing around strong work

Intelligence decomposition (`Local → Max → Local`) exists in two forms:

- the read-only reasoning roles (classify, plan, critique, diagnose,
  evaluate) already run local-first around every strong dispatch;
- `scheduling/preprocess.ts` compresses bulky **regenerable** context items
  (test logs, tool output) into small structured summaries via the local
  lane before a strong worker sees them. Pinned context and durable
  checkpoint state are never touched — the vNext.1 layering rules stand.

This module is the extension point for further local supporting activities
(file ranking, attempt-history summarization) in later phases.

## Quota model

Two **independent** windows, never combined into one percentage
(`quota/state.ts`, `quota/manager.ts`):

```text
FiveHourQuotaState   remainingRatio, resetAt, timeToReset, observedAt
WeeklyQuotaState     remainingRatio, resetAt, timeToReset, observedAt
```

An execution is subscription-admissible only when **both** windows are safe.

### Telemetry

`QuotaTelemetryProvider` (`quota/telemetry.ts`) is a clean acquisition
abstraction:

- **manual** (default): the operator-maintained
  `.specbridge/quota-telemetry.json`, kept current with
  `specbridge orchestrate quota-set --window five-hour --remaining 50
  --resets-in-minutes 20`;
- **fake**: deterministic, for tests;
- future machine-readable adapters implement the same interface when a
  *reliable* source exists. UI scraping and invented APIs are explicitly out.

Observations carry `observedAt`; freshness is assessed against
`scheduler.telemetryStaleMs`:

| Freshness | Behavior |
| --- | --- |
| `FRESH` | Full policy applies |
| `STALE` | No HARVEST; the reserve grows by `reserve.staleTelemetryExtraRatio`; decisions record the staleness |
| `UNKNOWN` | Mode `NORMAL`, conservative reserve; nothing is fabricated |

### QuotaForecast

The scheduler consumes a forecast **value** (`quota/state.ts`): both
windows, timing, freshness, the ledger-observed burn rate, and the derived
scheduler mode — so every decision is exactly reproducible in tests.

## Scheduler modes

Derived in one pure function (`quota/manager.ts`, `deriveSchedulerMode`):

| Mode | When | Behavior |
| --- | --- | --- |
| `NORMAL` | Capacity healthy | Strong work routes to the subscription freely — Max is prepaid; do not hoard it |
| `CONSERVE` | Five-hour remaining ≤ `conserveRemainingRatio` with the reset not imminent, **or** weekly pressure | Local-eligible work stays local; only small strong work fits under the larger reserve |
| `HARVEST` | Reset ≤ `harvestWindowMs` away **and** remaining ≥ `harvestMinRemainingRatio` **and** weekly healthy **and** telemetry fresh | The reserve drops toward its floor; useful strong work is actively admitted — unused capacity at reset is wasted |
| `EXHAUSTED_5H` | Five-hour remaining ≤ `fiveHourExhaustedRatio` | Strong work waits for the five-hour reset; local work continues |
| `EXHAUSTED_WEEKLY` | Weekly remaining ≤ `weeklyExhaustedRatio` | Strong work waits for the weekly reset; local work continues |

**Weekly scarcity dominates five-hour harvesting.** With 50% of the
five-hour window left and a reset in 15 minutes but 3% of the weekly window
remaining, the scheduler is in `CONSERVE`, not `HARVEST` — five-hour
capacity that the weekly window cannot back is not harvestable capacity.
Even in HARVEST, local-capable work stays local: the goal is maximum
*useful* Max utilization, never raw token consumption.

## Cross-reset admission

**Task duration versus time-to-reset is not an admission rule anywhere in
the codebase.** Admission (`scheduling/admission.ts`) asks the only question
that matters:

> How much quota will this task probably consume **before** the current
> window resets?

```text
preResetBurn  = expectedTotalBurn × min(1, timeToReset / expectedWallTime)
admit iff       preResetBurn × burnSafetyMultiplier
              ≤ fiveHourRemaining − dynamicReserve
      and       expectedWeeklyBurn × burnSafetyMultiplier ≤ weeklyRemaining
```

The post-reset continuation is evaluated separately against a full fresh
window. The canonical case, exercised as a mandatory test:

```text
five-hour remaining 50%, reset in 20 minutes
task: 50 minutes expected, 35% expected total burn
pre-reset burn ≈ 35% × (20/50) = 14%   →   START ON THE SUBSCRIPTION NOW
```

The task starts immediately and continues across the reset; the admission
decision records `crossesReset` and the pre-reset burn.

Burn-over-time is a **profile** (`linear` today): the abstraction is where
measured burn curves replace the assumption as ledger history accumulates.
Uncertainty is handled by the configurable `burnSafetyMultiplier` (a
conservative stand-in for P90-style estimates later phases may measure).

## Dynamic reserve

Never one permanent percentage (`scheduling/reserve.ts`):

```text
reset ≥ farResetMs away   → baseRatio            (default 20%)
reset ≤ nearResetMs away  → minRatio             (default 2%)
between                   → linear interpolation
weekly pressure           → + weeklyPressureExtraRatio
stale/unknown telemetry   → + staleTelemetryExtraRatio
```

Capacity has declining future value as its expiry approaches; uncertainty
always tightens admission, never loosens it.

## Workload profiling

`scheduling/profiler.ts` estimates three **independent** dimensions — a
task may run long while burning little quota, burn heavily in minutes, or
grow context out of proportion to both:

```text
expectedWallTimeMs · expectedFiveHourBurnRatio · expectedWeeklyBurnRatio
expectedContextGrowthTokens · retryProbability · confidence · basis
```

Heuristic complexity-class defaults (`scheduler.estimator`) are replaced
conservatively by ledger history: at least `minHistoricalObservations`
comparable **subscription-lane** measurements, medians only, and the burn
estimate never drops below half the heuristic. Weekly burn uses the
configurable `weeklyCapacityFactor` heuristic until real weekly telemetry
exists. No predictive model, by design.

## Context is part of admission

Quota capacity **and** context capacity are both required
(`scheduling/admission.ts`, `assessContextAdmission`). Before a large
dispatch, the durable-context occupancy of the task is estimated against
the vNext.1 context budget; at or above
`scheduler.contextCompactBeforeDispatchRatio` the decision carries
`COMPACT_BEFORE_EXECUTION` and the driver runs the vNext.1 path first:

```text
checkpoint (already durable) → compact → reconstruct bounded package → dispatch
```

AutoCompact and every other vNext.1 context guarantee are unchanged; local
workers participate in the same ContextLifecycleManager (the local endpoint
has no native compaction — `nativeCompaction: 'none'` is declared
explicitly, never papered over).

## Ready tasks, cooldown, and overtake

The scheduler inspects every READY node, not just the first
(`scheduling/scheduler.ts`, `selectReadyCandidate`):

- work that can run **now** beats work that would defer;
- in HARVEST, admissible strong work beats local work — it consumes
  capacity that is about to expire, while local work costs the same
  whenever it runs.

The initial graph chains tasks in plan order as an *ordering preference*.
During a subscription cooldown that preference must not become a global
stall: a LOCAL-lane node whose only unfinished predecessors are
quota-deferred strong tasks is **promoted** (recorded as a `node_ready`
event with `quotaOvertake`) and runs early. Deterministic verification
remains the arbiter of every completion, exactly as for in-order work.

When nothing can run, the job enters `WAITING_RETRY` with `retryAt` set to
the relevant reset — durable and resumable, never `BLOCKED`. The driver
holds short waits (`scheduler.maxQuotaHoldMs`) and stops with a `deferred`
result for long ones; `specbridge orchestrate run` resumes the job later.

## Scheduling decisions and the ledger

Every routing/admission decision persists a structured record
(`jobs/<id>/scheduling/decisions.jsonl`, bounded by
`scheduler.maxDecisionRecords`): lane, provider, mode, reason code, the
full quota forecast, the estimate, the reserve, context status, and
`deferUntil`. Reason codes are a closed vocabulary
(`LOCAL_SAFE`, `LOCAL_TRY_FIRST`, `STRONG_REQUIRED`,
`HARVEST_EXPIRING_CAPACITY`, `CONSERVE_QUOTA`, `WEEKLY_QUOTA_PRESSURE`,
`FIVE_HOUR_EXHAUSTED`, `WEEKLY_EXHAUSTED`, `COMPACT_BEFORE_EXECUTION`,
`LOCAL_ESCALATION_REQUIRED`, `CROSS_RESET_ADMITTED`,
`PRE_RESET_BURN_UNSAFE`, `STALE_TELEMETRY_CONSERVATIVE`,
`LOCAL_UNAVAILABLE`).

Attempt metrics gained optional quota/context observations — five-hour and
weekly remaining before/after, context usage before/after, test loops —
plus lane, suitability, category, and the scheduling-decision id. Unknown
telemetry stays `null`; a reset crossed mid-attempt makes the burn
underivable from endpoints and is recorded as unknown, **never** a
fabricated number. `quota/observations.ts` normalizes what was measured
(burn, burn/minute, wall time, success, by category/complexity/lane) so
later phases can learn P50/P90 without a schema change.

## Inspection

```text
specbridge orchestrate quota                 telemetry + forecast + mode + reserve
specbridge orchestrate quota-set …           record a manual quota observation
specbridge orchestrate scheduler <jobId>     mode, reserve, ready tasks, attempt lanes,
                                             recent scheduling decisions, and (vNext.4)
                                             the local execution strategy, harness
                                             binding + verified locality, per-task
                                             predicted mode, DIRECT vs HARNESS outcomes
specbridge orchestrate local-benchmark …     compare local execution modes on the same
                                             task in isolated worktrees (opt-in)
```

Lifecycle events (all additive): `quota_snapshot_updated`,
`scheduler_mode_changed`, `workload_estimated`,
`local_suitability_classified`, `scheduling_decision_created`,
`task_routed_local`, `task_routed_subscription`, `task_deferred`,
`harvest_entered`, `harvest_exited`, `dynamic_reserve_changed`,
`cross_reset_admitted`, `local_attempt_failed`,
`local_escalation_triggered`, `quota_telemetry_stale`, `quota_exhausted`,
`context_compaction_before_dispatch`.

## Configuration

Everything lives under `orchestration.jobs.scheduler` in
`.specbridge/config.json` (all defaulted; the block is additive and
deliberately outside the job policy fingerprint, like the context block —
quota thresholds are operational tuning):

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Off restores vNext.1 scheduling byte-identically |
| `maxLocalAttempts` | `2` | Bounded local execution attempts per task — **shared across both vNext.4 execution modes**, never per mode |
| `allowLocalExecution` | `true` | Gate for the source-mutating local path |
| `localExecution.*` | see [local agentic runtime](local-agentic-runtime.md) | vNext.4 execution-mode strategy, LOCAL harness binding, harness wall-time bound |
| `api.*` | see [API gap bridge](api-gap-bridge.md) | vNext.5 paid continuity lane: spend mode (`DISABLED` by default), API harness binding, operator pricing, budgets, gap thresholds |

Reliability thresholds live one level up, under `orchestration.jobs.reliability` — see [reliability runtime](reliability-runtime.md). They govern what happens AFTER an attempt fails, which is a different question from where it runs.
| `harvestWindowMs` / `harvestMinRemainingRatio` | `30m` / `0.25` | HARVEST entry |
| `conserveRemainingRatio` | `0.2` | CONSERVE entry |
| `weeklyPressureRatio` | `0.1` | Weekly pressure (suppresses HARVEST) |
| `fiveHourExhaustedRatio` / `weeklyExhaustedRatio` | `0.01` | Exhaustion |
| `telemetryStaleMs` | `15m` | Freshness bound |
| `burnSafetyMultiplier` | `1.25` | Admission safety margin |
| `contextCompactBeforeDispatchRatio` | `0.7` | Pre-dispatch compaction threshold |
| `deferPollMs` / `maxQuotaHoldMs` | `60s` / `10m` | Defer polling / hold-vs-stop boundary |
| `maxDecisionRecords` | `500` | Decision-record retention per job |
| `telemetrySource` | `manual` | Telemetry adapter |
| `reserve.*` | see above | Dynamic reserve shape |
| `estimator.*` | see above | Heuristic wall/burn defaults, weekly factor, history floor |

## See also

- [API gap bridge (vNext.5)](api-gap-bridge.md) — what happens when the
  subscription lane is unavailable for a materially long time
- [Local agentic runtime (vNext.4)](local-agentic-runtime.md) — how the LOCAL
  lane spends its compute once this document has chosen it

## Survival guarantees, unchanged

Scheduling never bypasses the vNext.1 runtime: every dispatch on every lane
is a durable ExecutionAttempt with checkpoint continuity, crash
reconciliation, context reconstruction, and restart recovery. Scheduler
state itself needs no extra persistence — mode, reserve, and routing all
re-derive from telemetry, configuration, the clock, and durable job state,
which is exactly what the restart scenarios exercise
(`tests/orchestration/quota-driver.test.ts`).
