# Subscription cooldown continuation

SpecBridge treats a rolling Strong-subscription limit as a temporary compute
constraint, not as an implementation defect and not as a product blocker.
Phase 8 makes that distinction at the WorkUnit boundary.

## Resource-scoped scheduling

The outer quota scheduler continues to own subscription telemetry, reset
times, economic policy, and API Gap Bridge authorization. For a mission
Objective, a quota-deferred Strong lane admits the Objective resource
controller instead of immediately deferring the whole node. The controller
then computes a bounded candidate set from:

```text
READY WorkUnits
+ Phase 6 readiness
+ Phase 7 OFF / AUTO / PREFER policy
+ healthy permitted compute
= runnable candidates
```

A WorkUnit routed to Strong while the subscription is cooling remains
`READY`. Its WorkGraph record gains a durable `resourceWait` with:

```text
reason = RESOURCE_COOLDOWN
resourceClass = STRONG_SUBSCRIPTION
availability = QUOTA_EXHAUSTED | COOLDOWN | RATE_LIMITED
since / lastObservedAt / optional wakeAt
optional routingWorkIdentity
fallbackPending
```

Readiness does not change. In particular, `STRONG_REQUIRED` never becomes a
failure, `NEEDS_CONTEXT`, or `NEEDS_RESEARCH` because capacity is absent.
The selector skips resource-waiting units and continues over later READY
siblings. PLANNED children still obey WorkGraph dependencies.

```text
READY:  WU-1 STRONG_REQUIRED   → resource-waiting
        WU-2 ELIGIBLE          → Secondary runnable
        WU-3 ELIGIBLE          → Secondary runnable

Result: WU-2/WU-3 continue; WU-1 stays durable and READY.
```

The Job enters `WAITING_RESOURCE` only when the candidate set is empty and
the remaining constraint is temporary resource availability. A known reset
becomes the existing scheduled wake time; an unknown reset uses the existing
bounded provider recheck policy. Neither path creates a human blocker.

## Attempt and candidate invariants

A provider quota refusal does not consume the WorkUnit implementation
attempt, Secondary repair budget, Strong fallback budget, Job task-attempt
budget, or ordinary agent-run budget. The controller closes its survival
record for audit, restores the WorkUnit to its pre-dispatch attempt number,
and persists the resource wait before yielding.

Candidates remain governed by the normal lifecycle:

```text
candidate → deterministic/semantic evaluation → verified candidate
          → single-writer integration → evidence
```

`CANDIDATE_READY` resume is unchanged: a process restart evaluates the stored
candidate instead of regenerating it. Completed or integrated Secondary work
is never reopened merely because Strong returns. Verified Secondary output
continues to unblock dependent WorkUnits normally.

If bounded Secondary repair has already selected `STRONG_FALLBACK`, cooldown
persists `fallbackPending` alongside the existing content-identity-bound
routing state. Time and process restarts do not reset the repair chain. On
recovery, Strong receives the preserved candidate diff, verification
failures, and attempt summaries exactly as in Phase 7.

## Recovery and policy behavior

The supervisor already gives operational resource waits priority over
restart/no-progress accounting. It sleeps in lease-renewing slices until a
known reset, or performs bounded health rechecks when the reset is unknown.
When capacity returns it clears the top-level operational wait; the Objective
clears only the matching WorkUnit resource constraints and recomputes the
candidate set. It does not decompose, research, bootstrap, or redo completed
work solely because time passed.

- `PREFER`: eligible work still prefers Secondary after Strong recovery.
- `AUTO`: routing is recomputed from the current quota/economic mode between
  attempts; readiness may be reused while the route changes.
- `OFF`: eligible implementation remains Strong-only. If no independent
  research or other permitted candidate exists, cooldown legitimately waits.
- API spend: unchanged. Phase 8 does not authorize a metered fallback.
- Attempts are atomic: an availability flip does not preempt an owned
  Secondary attempt or start a second backend for the same WorkUnit.

## Durable status facts

Each Objective stores `resources/strong-subscription.json`. It records the
cooldown episode, resource identity, reset metadata when known, waiting
WorkUnits, completed WorkUnits during cooldown, prevented Strong dispatches,
resource rechecks, and candidate reuse after restart. The WorkGraph remains
the source of per-unit state; this aggregate exists for status,
qualification, and later Phase 9 reporting.

## Deterministic five-hour qualification

The Phase 8 qualification uses an injectable clock/resource timeline; CI
does not sleep or consume real provider quota.

```text
00:00  Strong available; one Strong unit completes
00:10  Strong quota exhausted
00:10–05:10
        independent Secondary branches continue
        Strong-required units wait durably
        process state is serialized/reloaded mid-cooldown
05:10  Strong available; only remaining Strong work resumes
        Strong children unblock later Secondary work
final   all 15 WorkUnits complete
```

The canonical graph contains 15 WorkUnits: 10 Secondary-eligible and 5
Strong-required. It includes Secondary→Secondary, Secondary→Strong, and
Strong→Secondary dependencies. The deterministic result is:

```text
UsefulWorkDuringSubscriptionCooldown = 8
StrongRequiredWaitingDuringCooldown = 4
completedWorkRedone = 0
lostCandidates = 0
duplicateDispatches = 0
repairBudgetResets = 0
avoidableIdlePeriods = 0
humanInterventionsAfterSeal = 0
Job = COMPLETED
```

This qualification proves lifecycle and persistence behavior with fake
providers. It does not claim complete Phase 9 reporting, optimized token
economics, an LLM Gateway, remote Secondary targets, OpenMind, or learned
scheduling.
