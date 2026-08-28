# Contract closure

Mission `COMPLETED` is decided by a durable ledger of evidence, not by task
checkboxes and not by an agent's report.

---

## The failure this prevents

It already happened. The previous long-horizon dogfood declared a product
COMPLETE while **seven approved requirements had no implementation at all**.

Nothing lied:

- every task in the plan was checked off — true
- the build was green — true
- the unit tests passed — true
- the agent reported done — true

The defect was that *"the task list is complete"* and *"the contract is
satisfied"* were the same fact in the runtime. Here they cannot be.

## Three different concepts

| Concept              | Decided by                                          |
| -------------------- | --------------------------------------------------- |
| Task completion      | trusted verification of one task's evidence          |
| Objective completion | the objective runtime's evaluation                   |
| **Mission completion** | **every sealed contract item closed on evidence**  |

## The ledger

Built **once** from the seal, with one entry per sealed requirement,
invariant, and acceptance criterion. Nothing is filtered, summarized, or
grouped: an item that made it into the seal is an item a human approved, and
the whole value of the ledger is being exhaustive over exactly that set.

It is never rebuilt from live mission state mid-run. A mission whose
contracts keep evolving must not silently change what a running job is being
judged against; a genuinely changed contract is a new seal, which is a human
decision.

## The status ladder

```
NOT_STARTED   nothing claims to implement this
IN_PROGRESS   work exists and is in flight
IMPLEMENTED   something claims to; nothing has shown it
VERIFIED      trusted evidence demonstrates it holds     <- the only close
WAIVED        a human explicitly waived it, with a reason
NOT_APPLICABLE  explicitly out of scope by recorded decision
```

`IMPLEMENTED` and `VERIFIED` being different members is the entire fix.
Collapsing them reintroduces the bug exactly.

## What closes, and what does not

| Evidence kind                  | Closes? |
| ------------------------------ | ------- |
| `TRUSTED_VERIFICATION`         | yes     |
| `UNIT_TEST`                    | yes     |
| `INTEGRATION_TEST`             | yes     |
| `SYSTEM_SCENARIO`              | yes     |
| `BROWSER_SCENARIO`             | yes     |
| `ACCEPTANCE_CRITERION_CHECK`   | yes     |
| `REPRODUCIBILITY_RUN`          | yes     |
| `HUMAN_WAIVER`                 | via `WAIVED` |
| **`AGENT_ASSERTION`**          | **no**  |

`AGENT_ASSERTION` is a member so an audit can record that an agent claimed
something, and show that the claim closed nothing. An item whose only
evidence is an assertion carries the gap `EVIDENCE_UNTRUSTED`.

## Three rules that close the remaining holes

**Stale evidence does not close.** A result captured against a different git
head has not been disproved, but it also has not been re-demonstrated. A long
run that let old green results close items would close them against code that
no longer exists.

**A UI criterion cannot be closed by a unit test.** `requiresBrowserScenario`
and `requiresSystemScenario` are copied from the seal at ledger-build time,
where they were computed deterministically from text the human wrote.
Freezing them there means no agent later in the run can decide the browser
check was optional after all.

**An empty ledger cannot complete.** `missionMayComplete` refuses it rather
than reporting 100%: a seal that promised nothing has a closure ratio that
means nothing, and printing 1.0 for it would be the most misleading number in
the report. `closureRatio` returns `null` for an empty ledger, and the CLI
renders `n/a`.

## The gap-closure lifecycle

```
IMPLEMENTATION
     |
     v
CONTRACT CLOSURE AUDIT  <-------------------+
     |                                       |
     +-- unclosed items? --> GENERATE GAP WORK
     |                        implement, verify, audit again
     v
SYSTEM SCENARIO QUALIFICATION
     |
     +-- failed? --> diagnose, repair, replan, qualify again
     v
RELEASE QUALIFICATION
     v
REPRODUCIBILITY
     v
FINAL CONTRACT AUDIT
     v
COMPLETE
```

The loop is the point: an audit that finds unclosed items generates work and
returns to implementation, **however many tasks were already checked off**.
The originally-generated task list finishing is not the end of the night.

Gap work asks for the **right kind** of evidence. A missing browser scenario
is not closed by another unit test, and telling the runtime to "add tests"
for it would produce work that cannot succeed:

| Gap                    | Objective prefix                              | Closing evidence            |
| ---------------------- | --------------------------------------------- | --------------------------- |
| `NO_IMPLEMENTATION`    | "Implement and prove:"                         | trusted verification         |
| `NO_EVIDENCE`          | "Produce trusted evidence for:"                | trusted verification         |
| `EVIDENCE_FAILED`      | "Repair the implementation until this holds:"  | trusted verification         |
| `EVIDENCE_STALE`       | "Re-verify against the current state:"         | trusted verification         |
| `EVIDENCE_UNTRUSTED`   | "Replace an unverified claim with evidence:"   | trusted verification         |
| `SCENARIO_MISSING`     | "Build and run the scenario that demonstrates:" | browser / system scenario   |
| `REPRODUCIBILITY_FAILED` | "Make this reproducible from clean:"         | reproducibility run          |

The objective text is derived from the **sealed statement** plus the gap. It
never invents a requirement: an agent authoring new objectives from an audit
would be writing product intent, which is the authority the seal reserves.

The loop is bounded. Exhausting `maxGapClosureCycles` yields
`BUDGET_EXHAUSTED` — an honest failure, never a completion.

**Gap work is executed, not filed.** Each generated item gets one bounded
BUILDER in an isolated worktree; its changes land only if the FULL trusted
verification suite passes there and the patch applies cleanly to the
canonical tree. A successful repair registers `TRUSTED_VERIFICATION` for the
item — and resets `releaseQualificationPassed` and `reproducibilityPassed`,
because those were claims about a tree that no longer exists. (The first
dogfood generated gap work twelve times and nothing ever ran it; the files
sat on disk while the audit loop regenerated them.)

## Phases execute — counters count executions

Defect 39 of the vNext.10.1 dogfood: the runtime answered
`RUN_SYSTEM_SCENARIOS`, `RUN_RELEASE_QUALIFICATION`, and
`RUN_REPRODUCIBILITY` by stamping the phase onto the ledger and moving on.
The counters said the phases happened; nothing had ever run.
`reproducibilityPassed: false` on a COMPLETED job was the tell.

Now every `RUN_*` directive is answered by an EXECUTOR, and the oracle gates
each transition on the executor's recorded outcome — never on the ladder
having merely visited a phase:

| Phase                  | Executor runs                                            | The oracle reads              |
| ---------------------- | -------------------------------------------------------- | ----------------------------- |
| System scenarios       | saved + synthesized scenarios via `runSystemScenario`     | per-item scenario evidence    |
| Release qualification  | the full trusted suite against the INTEGRATED tree        | `releaseQualificationPassed`  |
| Reproducibility        | the suite in a clean detached-worktree checkout           | `reproducibilityPassed`       |

Scenario synthesis is deterministic and composes only things that already
carry trust: steps are the workspace's trusted verification commands, the
environment plan is attached only when the workspace has exactly one, and
browser scenarios only if someone authored them. An item that requires
evidence no executor can produce here stays open — and the executed-cycle
bounds (`maxSystemQualificationCycles`) convert that into an honest
`BUDGET_EXHAUSTED` naming the item, never a quiet pass.

A scenario that ran and FAILED routes to the repair loop first — re-running
the identical scenario against unrepaired code can only fail identically.
Once a repair lands after the failure, the item routes back to the scenario
phase, because only the scenario can close it.

## The completion gate

```ts
assertMissionMayComplete(workspace, jobId);  // throws, does not return false
```

It throws rather than returning a boolean because the caller is the code path
that would otherwise write `COMPLETED`. A boolean is a value somebody can
forget to check; an exception is not.

There is no override and no flag. The ledger is the input, and a ledger entry
only reaches a closing status through `assessItemClosure`, which only reads
evidence. The gate also enforces the whole-tree claims the ladder requires —
`releaseQualificationPassed` and (when the policy requires it)
`reproducibilityPassed` — so completion can no longer outrun phases the
oracle still wants. What the ladder requires and what the gate enforces are
the same facts, read from the same ledger fields, set only by the phase
executors.

## Audits are append-only

A completion claim has to be re-checkable months later, and "the ledger said
so at the time" is only meaningful if the ledger's state at that time is on
disk.

```bash
specbridge autonomy report <jobId>
```

```
Contract closure — phase FINAL_CONTRACT_AUDIT
  CTR-001/R1   VERIFIED   Sequential execution is deterministic given one workflow…
  CTR-001/R2   VERIFIED   Invalid transitions are rejected before any side effect.
  CTR-001#INV-1 VERIFIED  Actions never determine workflow transitions.
  AC-001       VERIFIED   A workflow definition runs end-to-end against a real…
  AC-002       VERIFIED   The dashboard page renders the execution history…
  AC-003       VERIFIED   Every rejected transition is refused before any side…
```

## Reproducibility

An autonomous mission must not declare completion on the strength of the
dirty developer environment that produced the feature. The build that passes
with a warm cache, a running database, and eleven hours of accumulated state
is not the build a person clones tomorrow.

Dimensions a run may exercise: `CLEAN_CHECKOUT`, `NO_BUILD_CACHE`,
`FRESH_DEPENDENCY_RESOLUTION`, `FRESH_ENVIRONMENT`,
`FRESH_APPLICATION_START`, `REPEATED_QUALIFICATION`.

A step that cannot run **here** is `UNAVAILABLE`, and an `UNAVAILABLE` step
makes the run `INCONCLUSIVE` rather than passing. Fabricating reproducibility
an environment cannot provide would be worse than not claiming it — a report
that says "reproducible" on a machine that could not do a clean build is a
claim about somebody else's machine.

A missing tool is `UNAVAILABLE`, not a failed build. Reporting it as a
failure would send the gap-closure loop off to repair code that compiles fine
everywhere else.

## Configuration

```jsonc
"autonomy": {
  "closure": {
    "enabled": true,
    "maxGapClosureCycles": 8,
    "maxSystemQualificationCycles": 4,
    "maxGapWorkPerCycle": 12,
    "requireSystemScenarios": true,
    "requireReleaseQualification": true,
    "requireReproducibility": true,
    "reproducibilityTimeoutMs": 3600000
  }
}
```

Turning `requireSystemScenarios` off does **not** make an unproven
requirement closed. It removes the scenario phase, and the requirement then
has to close on other evidence — or stay open.
