# Zero-touch certification

Unit tests prove each component's decision function is correct. They prove
nothing about whether a crashed driver at 03:00 actually results in a
restarted driver at 03:00.

The certification drives the assembled runtime through sixteen fault classes
and asserts against **what landed on disk**, never against what the runtime
said it did.

---

## The matrix

Fifteen operational faults must `SELF_RECOVER`. One authority case must reach
`NEEDS_AUTHORITY`.

| Id | Fault | Must do |
| --- | --- | --- |
| ZT-01 | strong provider unavailable | `WAITING_RESOURCE` / provider cooldown, resumed without a human |
| ZT-02 | strong quota exhausted | `WAITING_RESOURCE` with `wakeAt`; the supervisor sleeps and wakes itself |
| ZT-03 | local llama.cpp crash | `RECOVERING_PROVIDER`, restarted and continued |
| ZT-04 | invalid structured output | bounded retry, then a stronger tier. Never a question |
| ZT-05 | context exhaustion | checkpoint, compact, reconstruct, continue — durable attribution survives |
| ZT-06 | worker process terminated | the attempt is reconciled and re-dispatched |
| ZT-07 | driver process terminated | the supervisor observes the dead driver and restarts it under the same lease |
| ZT-08 | container service crash | `REPAIRING_ENVIRONMENT`, restarted within budget |
| ZT-09 | delayed service readiness | the readiness loop waits and proceeds when the service answers |
| ZT-10 | missing project dependency | `REPAIRING_TOOLCHAIN`; the Toolsmith installs it |
| ZT-11 | missing browser runtime | `SKIPPED_NO_RUNTIME` with a reason; a `BROWSER_RUNTIME` grant is requested |
| ZT-12 | failing implementation test | the item stays unclosed with `EVIDENCE_FAILED`; gap work repairs it |
| ZT-13 | wrong strategy, needs replan | the replan proceeds under delegated authority |
| ZT-14 | transient network failure | `RECOVERING_PROVIDER` and a bounded retry |
| ZT-15 | control-plane runner defect | `REPAIRING_CONTROL_PLANE`; governed repair opens |
| **ZT-16** | **sealed contract change required** | **`NEEDS_AUTHORITY`, and the sealed contract is not modified** |

ZT-16 is what makes the other fifteen mean something. A certification that
only proved self-recovery would certify a runtime that never asks —
*including when it should* — and that is a worse product than one that asks
too often.

## The verdict rule

```
every scenario met its expectation  AND  humanInterventionsAfterSeal == 0
    -> CERTIFIED

any scenario asked a human, got stuck, or took authority
    -> NOT_CERTIFIED

anything skipped or not run
    -> INCOMPLETE
```

`INCOMPLETE` exists so a partial run cannot round itself up. A certification
that ran twelve of sixteen scenarios has certified nothing, and reporting it
as a pass with an asterisk is how a suite stops being read.

## The outcomes

| Outcome | Means |
| --- | --- |
| `SELF_RECOVERED` | recovered and kept going |
| `NEEDS_AUTHORITY` | stopped for authority, correctly |
| `ASKED_HUMAN` | asked for something it should have handled |
| `STUCK` | stopped in a non-recoverable operational state |
| `SELF_AUTHORIZED` | took authority it did not have — **the worst outcome** |
| `SKIPPED_WITH_REASON` | could not run here, with the reason recorded |

A scenario that **throws** is recorded as `STUCK`, not as a crashed suite:
the runtime under test was supposed to handle whatever that was.

## Where faults are injected

Only at SpecBridge-controlled seams — a driver host, a readiness probe
executor, a browser driver, durable state on disk. No injection reaches
inside a provider process, and none of them exists as a runtime branch in
production execution code.

## It found three real defects

Before it went green, the certification caught bugs that the unit tests had
not:

**`CREATED` could not reach any operational status.** A job meeting a dead
provider on its very first dispatch threw `Invalid job transition` instead of
waiting. Seven of the sixteen scenarios crashed on it. The first dispatch is
as capable of finding a dead provider as the hundredth.

**The local-runtime signature missed the most common phrasing.** `\bexit\b`
does not match "exited", so `local model server exited with code 139` fell
through to an unclassified bounded retry. Nothing broke — and the runtime sat
on a backoff instead of restarting the process it could have restarted.

**Control-plane repair transitioned nowhere.** The classifier named
`REPAIRING_CONTROL_PLANE` and nothing performed it, so the repair record
opened against a job still in `CREATED` and the checkpoint stage never
completed.

That is what a certification is for. Every one of those would have ended a
real night.

## Running it

The matrix runs as part of the ordinary suite:

```bash
pnpm test tests/autonomy/zero-touch-certification.test.ts
```

Recorded runs are inspectable:

```bash
specbridge autonomy certification
```

```
zt-golden  CERTIFIED  interventions 0
  all 16 matrix scenarios met their expectation with 0 human intervention(s)
```

## What it does not prove

It does not prove a *product* can be built overnight — that is the
[dogfood](../orchestration/dogfood-qualification.md)'s job. It proves that
when the runtime meets these sixteen situations, it handles them itself, and
that when it meets an authority question it stops.

It also does not prove behaviour against faults not in the matrix. The matrix
is the list of things SpecBridge **claims** to survive without waking anybody;
a fault outside it is classified by the recovery classifier's fallback, which
is a bounded retry that eventually gives up honestly.
