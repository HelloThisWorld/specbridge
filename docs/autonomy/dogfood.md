# The vNext.10 dogfood

A real unattended run, against a real repository, with real compute — the
part of this phase that cannot be proved by tests.

The zero-touch certification proves the runtime handles sixteen injected
faults without waking anybody. That is a different claim from *it can build a
product overnight*, and this is where the second one gets tested honestly.

---

## Setup

**Target.** A git worktree of the completed StepRelay v1 repository on a
branch of its own:

```bash
git worktree add -b dogfood/vnext10-workbench ../steprelay-dogfood main
```

The v1 tree is never touched. Nothing in this exercise modifies StepRelay's
sealed product authority, and the worktree can be deleted without trace.

**Product intent.** The StepRelay Demo Workbench: a sample workflow with demo
actions, a REST control surface, a visual dashboard showing definitions,
executions, current state and event history, replay and redrive — running end
to end against a real PostgreSQL and a real Kafka via Docker Compose.

Three product contracts, sixteen requirements, three invariants, six success
criteria. Two of the criteria are written so the deterministic screens
classify them as implying a **system scenario** and a **browser scenario**,
because a workbench that closes on unit tests would prove nothing.

**Deliberately NOT specified**, because they are delegated engineering
decisions the runtime must make for itself: the frontend framework, the exact
REST paths, the Kafka topic topology, the Docker topology, the database
tables, the browser test implementation, polling versus websockets, and the
visual layout.

**Compute.** Real, all of it: `claude` on the subscription lane for planning,
diagnosis, replanning and implementation; a real llama.cpp server
(Qwen3.8-27B) for classification; Docker 29.1.3 and Compose v5.0.1; Java 25
and the committed Gradle wrapper.

## The evening

```
specbridge autonomy setup --mode overnight --specbridge-source D:/work/specbridge
  ✓ mode OVERNIGHT, human gate AUTHORITY_ONLY
  · Toolsmith: 8 capability classes
  · supervisor on, environments on, browser on, critic BLOCKING

specbridge autonomy seal steprelay-workbench --confirm
  Seal seal-6396a63c — SEALED
  · 3 contract(s), 16 requirement(s), 6 acceptance criterion/criteria
  implies system scenarios: true; implies browser scenarios: true

specbridge overnight preflight steprelay-workbench
  ✗ PROTECTED_PATHS_CONFIGURED: 0 protected path pattern(s)
      Declare protectedPaths before running unattended: an overnight run
      edits files for hours with nobody watching the diff.
  ✗ HUMAN_ACTION_REQUIRED
```

**Preflight earned its place on the first try.** The StepRelay configuration
had no protected paths, and an unattended run would have edited a completed
v1 tree for hours with nothing guarding the engine modules. Thirty seconds of
operator work in the evening:

```
✓ CONTAINER_RUNTIME: docker 29.1.3
✓ CONTAINER_COMPOSE: compose Docker Compose version v5.0.1
✓ BUILD_TOOLCHAIN_AVAILABLE: detected gradle-wrapper
· BROWSER_RUNTIME: the runtime installs its own browser when permitted
✓ OVERNIGHT_READY
```

Note the browser line: `SATISFIABLE_AUTONOMOUSLY`, not a blocker, because the
Toolsmith is permitted to provide it.

## What the run did

`specbridge overnight run steprelay-workbench`, then nothing.

```
closure ledger built with 25 sealed item(s)
lease acquired (generation 1)
BUILD_GRAPH → 3 nodes from the approved task plan
CLASSIFIER for task 1 on local-llamacpp        ← llama-server started on demand
PLANNER for task 1 on claude-code              ← real subscription dispatch
DISPATCH_EXECUTOR: task 1 ... expected burn 35.0% fits current capacity
executor-started: implement task 1 via claude-code [SUBSCRIPTION lane]
executor-finished: task 1: IMPLEMENTATION_DEFECT → diagnose
recovery: REPAIR (LOCALIZED_DEFECT_REPAIRABLE) — health DEGRADED
DIAGNOSER for task 1 succeeded
recovery: REPLAN (NO_PROGRESS_REPLAN) — health STALLED
REPLANNER for task 1 ...
```

Along the way, from the supervision log:

```
LEASE_ACQUIRED
DRIVER_STARTED
LEASE_EXPIRED_RECLAIMED  previous owner sup-42db… stopped heartbeating
DRIVER_STARTED
DRIVER_DIED              Projection wu-1-a02.json already exists…
DRIVER_RESTARTED
```

The lease reclaim is real: the first driver was killed mid-flight, stopped
heartbeating, and a later supervisor took ownership at **generation 2** and
carried on. Nobody typed `--resume`.

It ran for an hour, cycling implement → diagnose → replan → implement, and
then stopped **on its own budget**:

```
executor-finished: task 1: IMPLEMENTATION_DEFECT → blocked
JOB_BLOCKED: Recovery stopped: all 4 execution attempts for this task are spent.
WAIT_FOR_HUMAN: the job is BLOCKED and cannot proceed without a person
```

That is the bounded stop working. It did not loop, it did not spin, and it
did not quietly declare anything finished.

Final telemetry:

```
✗ humanInterventionsAfterSeal: 1
· authority escalations: 0
recoveries 0 · failovers 2 · quota waits 0 · context rollovers 0
toolsmith 0 (0 self-created) · gap cycles 0 · driver restarts 1
closure 0% · elapsed 60m · tokens 203,911 · cost $16.7335
```

**One intervention, honestly reported.** The run ended needing a person, so
the metric says so. It said `0` until the fourth defect below was fixed —
which is the most important thing this exercise produced.

`closure 0%` is the other honest number: the implementation never produced
passing evidence for any sealed item, so nothing closed, and the ledger said
so rather than reporting progress against a task list.

## The five defects it found

This is the reason to run a dogfood. None of them was caught by 2,500 tests,
and two of them were in code written years before this phase.

### 1. The plan-review gate was a complexity gate

The run stopped, cleanly and pointlessly:

```
AWAIT_HUMAN: Plan revision 1 for task 1 requires an explicit human review
(high-risk policy).
```

`planReview: 'high-risk'` fires when node complexity is `HIGH`. Nothing in
that plan touched a promise; the work was simply hard. Under
`humanGate: AUTHORITY_ONLY` this is precisely the 03:00 question the whole
phase exists to remove — and every other layer had been built to prevent it
while this one quietly kept it.

Fixed by routing the policy's conclusion through the authority firewall, with
the **plan text** passed through so the promise-vocabulary screen still runs:
a plan proposing a wire-format change or an auth bypass still reaches a
human; a plan that is merely large does not. It only ever relaxes — with no
resolver, no seal, or a resolver that throws, the v1.2 answer is unchanged.

The fix was then confirmed in the same live run rather than only in tests.
After the first implementation attempt failed and the runtime replanned, the
replacement plan went straight to work:

```
REPLANNER for task 1 ...
DISPATCH_EXECUTOR: Task 1 has an approved plan (revision 2) and is ready to
implement.
```

No `AWAIT_HUMAN`. A HIGH-complexity replacement plan, at 01:19, with nobody
watching.

The same fix exposed a wiring bug that would have hidden it:
`runUnattendedMission` took a `DriverHost` **value**, so the CLI necessarily
built the host before the authority resolver existed and the driver ran
without one. It takes a factory now.

### 2. A resumed attempt could not re-derive its projection

```
DRIVER_DIED  Projection wu-1-a02.json already exists; projections are
             immutable per (workUnit, attempt).
DRIVER_RESTARTED
DRIVER_DIED  Projection wu-1-a02.json already exists; …
```

Pre-existing, in the objective runtime. A driver that dies between writing a
projection and completing the attempt is reconciled onto that same attempt
number; the projection is derived again from the same durable truth; the
immutability check kills the driver. Every restart dies at the same line. The
supervisor's no-progress restart budget was the only thing preventing an
infinite loop — containment working, which is not the same as a fix.

Immutability and idempotence are different properties. Re-deriving the same
content is what every resume does; writing *different* content under the same
key is the thing the invariant exists to prevent, and still throws.

### 3. Windows batch verification commands could not be spawned at all

This one explains the entire shape of the run. Every builder candidate
recorded:

```json
"localVerification": { "ran": true, "passed": false, "commands": [
  { "name": "test",  "status": "spawn-failed" },
  { "name": "check", "status": "spawn-failed" } ] }
```

Since Node 20.12 / 22 (CVE-2024-27980), `spawn` without a shell rejects
`.bat` and `.cmd` with `EINVAL`. A correct security fix — and it silently
made the obvious Windows verification command impossible:

```jsonc
"argv": ["./gradlew.bat", "test"]   // spawn-failed, every time
"argv": ["./mvnw.cmd", "verify"]    // spawn-failed, every time
```

A resolved batch wrapper now runs through `cmd.exe` with a command line
SpecBridge builds itself: every element a discrete quoted token, so no
argument can become an operator, and Node's shell option is still never set
anywhere in the package. A source-level security test enforces that, and it
correctly rejected an earlier draft of the explanatory comment for merely
containing the forbidden string.

### 4. An unstartable verifier was treated as an implementation defect

The consequence of #3, and the more interesting bug. The objective evaluation
folded `spawn-failed` into a plain verification failure, so the runtime did
exactly what that category asks for: repaired the implementation, replanned,
repaired again. Three cycles rewriting code that had never been tested.

This is the distinction vNext.6 built its whole `INCONCLUSIVE` vocabulary
around, and the task-execution path has honoured it since v0.3 —
`executor-dispatch` marks a spawn-failed command `unavailable` because "a
command that never started proves nothing about the code". The objective path
did not. Both now share one definition of "did not run", and an unstartable
verifier is categorised `CAPABILITY_UNAVAILABLE` so recovery repairs the
toolchain rather than the code.

### 5. The primary metric under-reported

The sharpest one, because the measurement itself was wrong and so nothing
downstream could have noticed. The run ended in `BLOCKED` — a job that
plainly needs a person — and the report said:

```
✓ humanInterventionsAfterSeal: 0
```

`blockJob` records `budget_exhausted` rather than `job_blocked` when the
blocker is a budget, and the intervention event map listed only the latter.

A LIST of known causes can be incomplete. A job's current STATUS cannot be.
Interventions are now also derived from the job sitting in a human-attention
status, whatever event carried it there — `NEEDS_AUTHORITY` still excluded,
because folding governance-working into the metric would make it
unfalsifiable in the other direction. The same run now reports `1`.

## What this proves, and what it does not

**Proved.**

- The evening ritual works end to end on a real repository, and preflight
  catches a real prerequisite before the night rather than during it.
- A seal compiled from real mission truth produces a real closure ledger
  (25 items) and the sealed criteria correctly imply system and browser
  scenarios.
- The supervisor genuinely owns liveness: a killed driver's lease expired,
  was reclaimed at a new generation, and work continued.
- The runtime genuinely self-recovers from an implementation defect:
  `IMPLEMENTATION_DEFECT → DIAGNOSING → REPAIR/REPLAN`, with `health
  DEGRADED` then `STALLED` assessed from real evidence.
- `humanInterventionsAfterSeal` stayed at **0** across every one of those.
- Real local and subscription compute, real provider-reported usage, no
  fabricated cost.

- The bounded stop is real: attempts exhausted, `BLOCKED`, one intervention
  reported. No loop, no spin, no quiet completion.

**Not proved, and not claimed.**

- **The product was not built.** The run never got past task 1 of 3, and the
  reason was defect #3: its verification commands could not start, so no
  implementation could ever be accepted. The fixes are covered by regression
  tests; the dogfood was NOT re-run to completion afterwards, because a
  genuine overnight-scale build is not something a working-day session can
  contain. `closure 0%` and the unclosed ledger say exactly that, and the
  completion oracle would have refused `COMPLETED` regardless.
- **The browser and environment paths were not exercised end to end here.**
  No system scenario ran, because the implementation never reached the point
  of having something to run one against. Both are covered by their own
  tests and by the certification; neither has yet been proven against this
  product.
- **The control-plane repair path was configured but never triggered.** Which
  is itself worth noting honestly: three of the five defects above WERE
  recoverable SpecBridge defects, and the runtime did not recognise them as
  such. Nothing classified `spawn-failed` verification, a crash-looping
  projection write, or a mis-categorised failure as `CONTROL_PLANE_DEFECT`,
  so the governed repair path was never entered. Detection is the gap: the
  repair machinery is tested, and what feeds it is narrower than the defects
  a real run produces.

## Reproducing it

```bash
git worktree add -b dogfood/vnext10-workbench ../steprelay-dogfood main
cd ../steprelay-dogfood
specbridge autonomy setup --mode overnight
# declare protectedPaths, then:
specbridge autonomy seal steprelay-workbench --confirm
specbridge overnight preflight steprelay-workbench
specbridge overnight run steprelay-workbench
```

Everything the run wrote is under `.specbridge/autonomy/` in that worktree:
the seal, the closure ledger, the supervision log, the preflight reports, and
the telemetry. None of it is summarized here that is not also on disk there.
