# Dogfood and release qualification (vNext.9)

The first eight phases each added a capability. This one adds none. It adds
the machinery for answering, with evidence, a single question:

> Can the operator give SpecBridge a meaningful product direction, leave it
> operating across a genuinely long engineering horizon, and trust that it
> will keep making bounded, economically rational, evidence-governed
> progress until the Mission is either verified complete or honestly blocked
> for a reason that requires real human authority?

Everything here is **opt-in**. A workspace that never runs a qualification
command behaves exactly as it did before vNext.9: no file is created, no
policy changes, and no ordinary job is affected.

---

## The two modes

| Mode | What it is | Where it runs |
| --- | --- | --- |
| **Deterministic qualification** | Fully offline. Fake local model, fake harness runtime, fake strong runner, fake API provider, fake quota telemetry, fake clock, temporary repositories. | CI, and `specbridge orchestrate qualify run` |
| **Real dogfood** | The actual product repository with configured real resources. Operator-initiated, never automatic. | An operator's machine, over hours or days |

They answer different questions. The deterministic mode asks *does the
runtime still uphold its invariants?* — and is the permanent regression
safety net. The real dogfood asks *can it actually build the product?* — and
is the release gate. Neither substitutes for the other, and the report never
lets one be mistaken for the other.

---

## Quick start

```bash
specbridge orchestrate qualify scenarios
```

```bash
specbridge orchestrate qualify run --profile offline
```

```bash
specbridge orchestrate qualify report <run-id> --markdown
```

---

## The scenario matrix

The matrix is the machine-readable contract of what a release must prove. It
lives in `packages/orchestration/src/qualification/matrix.ts` and is exposed
through `orchestrate qualify scenarios --json`.

Each scenario declares:

- the **invariant** it proves, in one sentence;
- the **fault classes** it injects;
- the **resources** it touches, for real-versus-simulated attribution;
- its **requirement** — `REQUIRED`, `REQUIRED_WHEN_EXERCISED`, or the single
  `RELEASE_GATE`;
- its **execution kind**, which decides where it can honestly run.

### Execution kinds

| Kind | Meaning |
| --- | --- |
| `POLICY` | Pure production policy functions with deterministic inputs. Runs anywhere — no workspace, no processes, no providers. |
| `RUNTIME` | The real job driver over a temporary workspace with deterministic doubles. Owned by the regression qualification suite. |
| `REAL_RESOURCE` | Needs a real provider, a real quota window, or real money. Cannot be simulated. |

The distinction is what keeps a report honest across executors. The CLI
executes `POLICY` scenarios; the regression suite executes `RUNTIME` ones.
Neither can claim the other's coverage, and a `REQUIRED` scenario in any
skipped state blocks the release verdict.

### Adding or changing a scenario

Adding one is additive. **Removing one, or weakening its `requirement`, is a
release-gate change** — the exact kind of quiet relaxation the phase forbids.
Two tests enforce this from opposite directions:

- every fault class SpecBridge claims to survive must be injected by some
  scenario;
- every `RUNTIME` scenario must be recorded as `PASS` by the test file that
  actually observes it.

---

## Profiles

```text
offline        deterministic fakes only; no network, no provider, no money
local          real local compute; strong lanes stay deterministic fakes
subscription   real local compute and a real subscription runner
full           local + subscription + API, still bounded by existing policy
```

A profile is a **ceiling, never a grant**. In particular, `full` does not
authorize spending: the vNext.5 spend mode, budget, and per-task approval
rules apply unchanged, and a `full` run against `apiSpend.mode = DISABLED`
legitimately produces zero API usage. That is a valid — often the desirable —
result.

---

## Preflight

```bash
specbridge orchestrate qualify preflight --profile subscription --target /path/to/product
```

Preflight **fails closed**. A dogfood run mutates a repository over hours
while nobody is watching, so every check refuses rather than warns when it
cannot establish safety:

- the target repository resolves and is a git repository;
- the working tree is clean, or execution is confined to an isolated
  worktree — an *undetermined* repository state refuses for the same reason a
  dirty one does;
- the runners the profile needs are configured;
- spending, if enabled, has a budget ceiling, a bound harness profile, and —
  for `AUTO_BOUNDED` — a pricing profile;
- trusted verification commands exist;
- protected paths are declared.

Preflight also surfaces the economic configuration. **Showing configuration
is not approval.** Nothing in preflight authorizes a single dollar.

```bash
specbridge orchestrate qualify economics
```

---

## Running the deterministic qualification

```bash
specbridge orchestrate qualify run --profile offline
```

This creates a durable run under `.specbridge/qualification/<runId>/`,
executes every `POLICY` scenario against real production policy functions,
and records an honest `SKIPPED_WITH_REASON` for everything it cannot reach.

A qualification run is a **durable accumulator, not a process**. Results
arrive from more than one executor and the run survives all of them being
interrupted:

```bash
specbridge orchestrate qualify run --profile offline --run-id <run-id> --failed-only
```

```bash
specbridge orchestrate qualify run --profile offline --scenario quota.harvest --scenario api.disabled-no-spend
```

Re-running a scenario **replaces** its result, so a fix genuinely turns a
`FAIL` into a `PASS`. Everything else — faults injected, audits taken, humans
who intervened — is append-only, because those are facts about the past.

---

## Running the real dogfood

Real dogfood execution is the **existing job surface**, unchanged:

```bash
specbridge orchestrate run <spec>
```

```bash
specbridge orchestrate run <spec> --resume <jobId>
```

There is deliberately no second job scheduler and no second state engine.
Start, stop (Ctrl+C), inspect, restart, resume, and survival across a machine
reboot are all provided by the Job durability that already existed — the
qualification layer only binds run identity and reporting to it.

The dogfood layer adds:

1. **Preflight** before anything starts (above).
2. **Run identity**: SpecBridge version and commit, Node version, platform,
   local model identity, harness and runner versions where reported, context
   strategy, adaptive mode, the target's starting commit and branch, and a
   configuration fingerprint. Unknown stays `null` — a guessed version in a
   release report is worse than an absent one. **No credentials are stored.**
3. **Reporting** from the durable records the job already writes.

### Safety

Never run a dogfood directly on an unsafe working branch. Use a dedicated
branch and an isolated worktree; preflight refuses a dirty unrelated tree.
Final integration always passes through the existing single-writer path —
dogfood mode has no shortcut around it.

---

## Pause, resume, and cancel

Pausing is an **operator decision, not a worker outcome**. A run paused
overnight records paused time separately from active time, and writes no
attempt, no failure, and no reliability observation. Poisoning the adaptive
and reliability histories with operator-requested stops would make every
later placement decision worse for a reason nobody could find.

Cancellation goes through the existing job control:

```bash
specbridge orchestrate cancel-job <jobId>
```

Active workers are cancelled, budget accounting reconciles, and checkpoint
integrity is preserved.

---

## Fault injection

Fault injection exists as **explicit dependency injection only**. There is no
configuration key, no environment variable, no CLI flag, and no MCP tool that
constructs a fault plan, and nothing in the driver, scheduler, reliability,
context, or adaptive runtime imports the fault module. A fault fires only
when a caller builds the plan in code and hands it to a seam it is already
injecting — which is to say, when a test does what a test may already do.

Injection happens at SpecBridge-controlled boundaries:

```text
QUOTA_TELEMETRY        the injected telemetry provider
LOCAL_INFERENCE        the injected local executor inference
RUNNER_REGISTRY        the runner a dispatch resolves
VERIFICATION_COMMAND   a trusted verification command's own process
DURABLE_STATE          state on disk under .specbridge/
DERIVED_CACHE          a cache under .specbridge/cache/
CLOCK                  the driver's injected clock and sleep
PROCESS                the orchestrating process (abort, kill, restart)
```

No boundary reaches inside a provider process, and a structural test asserts
that no production module imports the fault model.

---

## State invariant auditing

The auditor reads persisted state and answers one question: is what is on
disk right now self-consistent, and does it still say what governance
requires? It never writes — an auditor that could write could launder the
corruption it exists to find.

It is taken **before and after every restart** and **after every injected
fault**, because the durability bug most likely to be found is state that is
valid before a restart and invalid after hydration. `restartRegressions()`
tells that apart from state that was already wrong.

Blocking invariants — a violation of any is a release blocker:

```text
COMPLETED_TASK_HAS_EVIDENCE
COMPLETED_TASK_HAS_EVALUATION
API_BUDGET_RECONCILES
NO_API_SPEND_WITHOUT_AUTHORITY
LOCAL_ATTEMPTS_VERIFIED_LOCAL
DEPENDENTS_RESPECT_VERIFIED_PREDECESSORS
GRAPH_REVISION_RESOLVES
```

---

## Human intervention accounting

Every human intervention is recorded and classified. The whole value of the
classification is the line between governance working and autonomy failing:

| Kind | Meaning |
| --- | --- |
| `REQUIRED_BY_POLICY` | A governance boundary required a human. **Intended.** |
| `MISSING_INFORMATION` | The Mission genuinely lacked product information only a human had. |
| `RUNTIME_FAILURE` | A human had to act because the runtime broke. |
| `UNNECESSARY_CLARIFICATION` | SpecBridge asked what it should have resolved. |
| `MANUAL_RECOVERY` | A human steered recovery the runtime should have chosen. |
| `MANUAL_CODE_FIX` | A human edited generated source. **A serious autonomy failure.** |
| `MANUAL_SCHEDULING` | A human overrode placement or resource scheduling. |
| `MANUAL_CONTEXT_REPAIR` | A human re-supplied information canonical artifacts already held. |
| `MANUAL_STATE_REPAIR` | A human edited durable control state. **Release-blocking.** |

`REQUIRED_BY_POLICY` must name the governance boundary that required it. Without
that rule, the most consequential distinction in the report would rest on the
recorder's choice of adjective.

A manual code fix is **never** filed as an approval. If the operator had to
repair generated implementation by hand, the autonomous runtime failed to
complete that portion, the Mission may still finish, and the verdict reflects
it.

---

## Interpreting the report

```bash
specbridge orchestrate qualify report <run-id>
specbridge orchestrate qualify report <run-id> --json      # for CI
specbridge orchestrate qualify report <run-id> --markdown   # for humans
```

Four artifacts land under `.specbridge/qualification/<runId>/reports/`:

| Artifact | For |
| --- | --- |
| `qualification-summary.json` | CI: verdict, blockers, unproven required scenarios |
| `qualification-report.md` | Humans: the complete narrative |
| `scenario-results.json` | Per-scenario detail with observed transitions |
| `mission-metrics.json` | The scorecard and the four derived reports |

### What was real, and what was simulated

Every resource is reported as `REAL`, `SIMULATED`, or `NOT_EXERCISED`. There
is no fourth value and in particular no "equivalent": a fake clock that
advanced five hours produced *simulated* evidence about a five-hour window,
and the report says so. Attribution folds conservatively — `REAL` beats
`SIMULATED` beats `NOT_EXERCISED` — so one fake reset can never make the
report claim a real quota window.

### Reading the numbers

**An unreported measurement is `unknown`, never `0`.** A provider that said
nothing about token usage must not look cheaper than one that reported
honestly, and a Mission with no verified task must not show a 0% success rate
that reads like a measured failure. Counts of *events* are different — "no
oscillation was detected" genuinely is zero.

**Context is reported per verified task, not only per attempt.** A first-prompt
token reduction paid back in retries is not a saving.

**Shadow recommendations are recommendations.** No counterfactual outcome is
attributed to an unexecuted candidate anywhere.

---

## Release gates

The verdict is computed in strict order, and the order is the policy:

1. **Zero-tolerance integrity conditions**, which are counted, not judged.
2. **Required scenarios**, where a skip is not a pass.
3. **The real-product release gate**, which a fixture can never satisfy.
4. Only then, **limitations**, which can downgrade but never upgrade.

### Zero tolerance

Any non-zero count is a `FAIL`, whatever else passed:

```text
unauthorizedPaidExecutions
canonicalStateLosses
adaptiveHardPolicyBypasses
evidenceBypassCompletions
unrecoverableInjectedFaults
acceptedProtectedStateMutations
unboundedRetryLoops
manualDurableStateRepairs
dependentsOnFailedPredecessors
```

### The verdicts

| Verdict | Meaning |
| --- | --- |
| `PASS` | Every gate held and nothing meaningful is unproven. |
| `PASS_WITH_LIMITATIONS` | Every correctness and governance gate held; meaningful non-blocking efficiency or usability limitations remain. |
| `FAIL` | A zero-tolerance condition was observed, a required scenario failed or is unproven, or the real-product gate was not met. |

`PASS_WITH_LIMITATIONS` is **not** a softer landing for a real failure. It is
unavailable whenever a zero-tolerance condition was observed, a required
scenario failed, or the real-product gate is anything other than `PASSED`.

### The real-product gate

`realTargetQualification` is reported **separately** from the verdict, as
`PASSED`, `FAILED`, or `NOT_RUN`. A run that built and proved all the
machinery but never met the external prerequisite reports `NOT_RUN` and
`FAIL` — it demonstrated the machinery, not the release, and calling that
`PASS_WITH_LIMITATIONS` would be exactly the exaggeration this phase exists
to prevent.

### If qualification fails

Fix the defect, or report `FAIL`. Do not skip the scenario, change the
expected result, relax the invariant, disable evidence, raise a retry limit
until it succeeds, enable the API to brute-force completion, or quietly
simplify the Mission. `computeVerdict` takes no policy parameters at all,
deliberately: there is no argument by which a caller can make a gate more
permissive for one run than for another.

---

## Mission scope changes

If the operator legitimately changes the Mission mid-dogfood, the change is
recorded with its original scope, its new scope, the reason, the authority,
and its effect on qualification. Both scopes appear in the report. A reduced
Mission can never be presented as though it were the one that was approved.

---

## Dogfood-driven fixes

Every SpecBridge defect discovered by dogfood is recorded with its source —
`MODEL_IMPLEMENTATION`, `RUNTIME_STATE`, `POLICY`, `CONTEXT_RETRIEVAL`,
`INFRASTRUCTURE`, `EVALUATION_INFRASTRUCTURE`, or `CONFIGURATION`. "The model
failed" is not a member, and that is the point: every failure must be
attributed to a layer that can be fixed, and a catch-all would absorb exactly
the runtime defects dogfood exists to find.

A fix without a regression test shows in the report as **uncovered**.

---

## Known limitations

- **The real StepRelay dogfood is an unmet external prerequisite in
  environments where that repository is unavailable.** The machinery is
  built, the deterministic qualification runs, and
  `realTargetQualification` reports `NOT_RUN`. This is not converted into a
  pass under any circumstances.
- `local.harness-success` is recorded by the vNext.4 harness driver test
  rather than by a qualification-suite file of its own: the fake DSH runtime
  is configured through ambient environment variables, and a second file
  driving it concurrently would race on the Windows threads pool.
- Real quota-window validation requires a real subscription and real elapsed
  time. Offline runs record `FIVE_HOUR_WINDOW` as `SIMULATED` and the
  corresponding `REQUIRED_WHEN_EXERCISED` scenario as a coverage limitation
  rather than a pass.

---

## See also

- [survival-runtime.md](survival-runtime.md) — durable attempts and checkpoints
- [quota-scheduling.md](quota-scheduling.md) — lanes, admission, HARVEST
- [api-gap-bridge.md](api-gap-bridge.md) — paid continuity and spend authority
- [reliability-runtime.md](reliability-runtime.md) — evaluation, assessment, recovery
- [context-efficiency.md](context-efficiency.md) — retrieval and progressive expansion
- [adaptive-scheduler.md](adaptive-scheduler.md) — history-informed placement
- [../security/threat-model.md](../security/threat-model.md) — the dogfood threat section
