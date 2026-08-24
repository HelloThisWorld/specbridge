# Supervisor lifecycle

The supervisor is what makes "leave it running overnight" mean anything.

A v1.2 job needed a foreground terminal. If the shell closed, the driver died
with it, and the job sat in whatever status it happened to be in until a
person typed `--resume`. Every word of that sentence is a reason an
eight-hour window ends after forty minutes.

---

## The protocol

```
take the lease  ->  decide  ->  act  ->  heartbeat  ->  repeat
```

The supervisor holds **no in-memory truth**. Restart counters, backoff, and
progress fingerprints are persisted before they are used, so a supervisor
that is itself killed and restarted continues from the same accounting rather
than generously granting the crash loop a fresh budget.

## Leases

Ownership is a file with an owner id, an expiry, and a generation counter.
That is the whole protocol, deliberately:

- A dead owner stops heartbeating.
- The lease expires.
- The next supervisor reclaims it and bumps the generation.

It works identically whether the previous owner exited cleanly, was killed,
or the machine lost power — because the failure being handled is precisely
the one where no cleanup code runs.

**`pid` and `hostname` are diagnostic, never authoritative.** A pid can be
recycled and a hostname can be shared. Liveness is decided by `expiresAt`
alone; the fields exist so an operator can find the process, not so the
runtime can trust them.

**A live lease is never preempted.** There is deliberately no force flag. Two
drivers mutating one job's durable state is the failure this exists to
prevent, and "it looked stuck" is exactly how that happens. An operator who
believes a lease is stale can wait for it to expire, which takes at most
`leaseTtlMs` and is always correct.

**The generation bump makes a zombie detectable.** An owner returning from a
long stop-the-world pause finds a higher generation and stands down instead
of writing over the new owner's work.

The schema enforces `leaseTtlMs >= 3 * heartbeatIntervalMs`. A tighter lease
reclaims jobs from live owners.

## The decision function

`decideSupervision()` is pure and total. The loop does I/O; this decides.
That split is what makes a fifteen-hour unattended behaviour testable in
milliseconds — every interesting scenario is a struct.

The ordering is the policy, and the first three cases carry the argument
about who gets woken:

1. **A final job releases.** Nothing to supervise.
2. **A human-attention job releases too.** This is the important one: the
   supervisor does *not* sit on a job waiting for a person. A held lease
   means "I am working on this", and it is not. Releasing makes the stop
   visible to whatever wakes the human.
3. **An operational job never releases.** It sleeps, re-checks, or gives up
   honestly — and the difference between those three is the difference
   between an overnight run that finishes and one that does not.

## Sleeping vs re-checking

| Wait kind                    | Behaviour                                        |
| ---------------------------- | ------------------------------------------------ |
| `SUBSCRIPTION_QUOTA_RESET`   | **sleep** until the known reset                   |
| `PROVIDER_COOLDOWN`          | **sleep** until the known cooldown ends           |
| `PROVIDER_RATE_LIMIT`        | **sleep**                                         |
| `API_BUDGET_WINDOW`          | **sleep**                                         |
| `UNKNOWN_CAPACITY`           | **re-check** on an interval, then classify        |
| `NO_RECOVERY_IDENTIFIED`     | **give up**, honestly and immediately             |

A quota window that resets at 04:00 is a schedule: there is nothing to learn
before then, and polling it burns a laptop all night for no information. A
provider that is simply down has no known return, so it is polled — and
eventually admitted to be unrecoverable, which is a legitimate way for an
unattended run to end and a lie if reported as anything else.

Long sleeps are taken in heartbeat-sized slices so the lease stays fresh. A
five-hour quota window must not look like a dead owner for four of them.

## Restart accounting

The progress comparison is the whole point.

```
driver exited having MOVED the job  ->  backoff reset, strike cleared
driver exited having changed NOTHING ->  backoff doubled, strike recorded
```

A driver that starts cleanly and dies five seconds later has not earned a
fresh budget. Treating a *start* as success is how a crash loop runs all
night at full speed.

The fingerprint is deliberately coarse — status, graph revision, completed
nodes, total attempts, agent runs. It answers a yes/no question about forward
motion. A finer fingerprint would be true on every heartbeat and therefore
useless for detecting a crash loop.

Two independent bounds:

- `maxConsecutiveRestarts` — restarts *with no progress*. Reaching it gives
  up, because restarting again would repeat the same failure.
- `maxRestarts` — total, ever. A backstop.

Reaching `maxSessionMs` is **not** a failure: the job is checkpointed and left
resumable, and a fresh supervisor picks it up.

## The driver host

`DriverHost` is an interface rather than a call, for three reasons that all
matter:

- The certification injects a host that **crashes on demand**. Proving "a
  terminated driver is restarted without a human" needs a driver that can be
  terminated deterministically, and killing real processes in a test suite is
  neither deterministic nor kind to CI.
- In-process and child-process supervision are genuinely different
  trade-offs and both are legitimate.
- The supervisor's own logic should not care. Every decision it makes is
  about lease state, job status, and progress — none of which changes
  depending on where the driver ran.

A host **never throws for an ordinary driver failure.** It returns a
`crashed` outcome, because a crashed driver is a normal event in this runtime
and an exception would make the supervisor's loop responsible for being
exception-safe on every path.

## Configuration

```jsonc
"autonomy": {
  "supervisor": {
    "enabled": true,
    "heartbeatIntervalMs": 15000,
    "leaseTtlMs": 90000,          // >= 3x heartbeat, enforced
    "pollIntervalMs": 20000,
    "maxRestarts": 50,
    "maxConsecutiveRestarts": 5,   // restarts with no progress
    "restartBackoffMs": 5000,
    "maxRestartBackoffMs": 300000,
    "maxSessionMs": 50400000,      // 14h; reaching it is not a failure
    "maxIndefiniteWaitMs": 7200000 // 2h on an unknowable wait, then classify
  }
}
```

Every bound can only make the supervisor give up **sooner**. There is no
field that lets it restart forever.

## Inspecting

```bash
specbridge autonomy status
```

```bash
specbridge autonomy supervision --limit 100
```

Both are read-only. Inspection is never required for progress — a runtime
whose progress depended on somebody watching would not be unattended.
