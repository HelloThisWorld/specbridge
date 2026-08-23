# Autonomy telemetry

One number is the product metric:

```
humanInterventionsAfterSeal = 0
```

Everything else in the record exists to make that number believable.

---

## Why the rest is there

A run reporting zero interventions and nothing else could be a run that did
nothing. A run reporting zero interventions **alongside** nine provider
failovers, four quota waits, two context rollovers, and eleven self-created
tools is a run that earned it.

## The counters

Things SpecBridge itself observed, so they are genuine integers:

| Counter                       | Counts                                       |
| ----------------------------- | -------------------------------------------- |
| `humanInterventionsAfterSeal` | **the product metric** (see below)            |
| `humanAuthorityEscalations`   | correct stops for product authority           |
| `autonomousRecoveryCount`     | operational conditions cleared without a human |
| `providerFailovers`           | tier or lane escalations                      |
| `providerFailures`            | local runtime / harness failures observed      |
| `quotaWaits`                  | waits on capacity                              |
| `contextRollovers`            | fresh sessions from durable state              |
| `toolsmithActions`            | capability requests made                       |
| `selfCreatedTools`            | tools the run wrote and **applied**            |
| `toolchainRepairs`            | missing tooling provisioned                    |
| `environmentRepairs`          | environments restarted or repaired             |
| `controlPlaneRepairs`         | governed SpecBridge repairs                    |
| `gapClosureCycles`            | audit → gap work → implement → audit loops     |
| `systemQualificationCycles`   | system scenario passes                         |
| `browserScenariosRun`         | browser scenarios executed                     |
| `uxCritiquesRun`              | critiques recorded                             |
| `driverRestarts`              | supervisor driver restarts                     |
| `supervisorWakeups`           | scheduled and resource-return wakes            |

## The measurements

`number | null`. **Never 0 for an unknown.**

| Measurement            | `null` means                                 |
| ---------------------- | -------------------------------------------- |
| `elapsedWallTimeMs`    | the run's span could not be determined        |
| `reportedTokens`       | no provider reported token usage              |
| `reportedCostUsd`      | no provider reported a cost                   |
| `contractClosureRatio` | there is no ledger, or it is empty            |

A provider that reported no cost has **not** reported a cost of zero. A
telemetry record printing `$0.00` would be inventing a fact about money, so
`formatMeasurement` renders `null` as `n/a` and every surface uses it.

`contractClosureRatio` is `null` for an empty ledger rather than `1.0`: a
seal that promised nothing has a ratio that means nothing, and 100% would be
the most misleading number in the report.

## What counts as an intervention

An intervention is a human doing something **the runtime should have
handled**:

| Job event               | Counted? | Why                                        |
| ----------------------- | -------- | ------------------------------------------ |
| `clarification_requested` | **yes** | it asked something it should have resolved  |
| `job_blocked`             | **yes** | it stopped needing an explicit user action  |
| `authority_escalated`     | **no**  | governance working; counted separately      |

Folding authority escalations into the intervention count would make the
primary metric unfalsifiable in **both** directions: a runtime could claim
zero by escalating everything, or claim failure by escalating once,
correctly.

## Derived, not accumulated

Every number is recomputed from the job event log, the ledgers, and the
records on disk. A counter incremented in memory would be wrong after the
first process restart — and process restarts are the normal case here.

## Reading it

```bash
specbridge autonomy report <jobId>
```

```
Autonomy
  ✓ humanInterventionsAfterSeal: 0
  · authority escalations: 0
  recoveries 7 · failovers 3 · quota waits 2 · context rollovers 1
  toolsmith 5 (3 self-created) · gap cycles 2 · driver restarts 1
  closure 100% · elapsed 6.2h · tokens 1,284,331 · cost n/a
```

`cost n/a` there is the honest reading of a local-only run: nothing reported
a price, so nothing is claimed.

## In the certification

The zero-touch certification aggregates `humanInterventions` across every
scenario, and **a single one anywhere is `NOT_CERTIFIED`** whatever else
passed. It is a count rather than a boolean because "essentially zero" is not
a thing, and a report that rounded one intervention down to none would make
the primary product metric decorative.
