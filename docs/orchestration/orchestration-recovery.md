# Orchestration recovery

Resuming an interrupted governed run, honestly.

## Three rules

**A resumed run is the same run.** It keeps its id, its counters, its plan
revisions, and its event history. A new run is never presented as a
continuation, and the tooling says so when someone tries.

**A resumed agent remembers nothing.** Only persisted structured state is
trusted. There is no field that could carry a previous session's reasoning, so
a fresh session has nothing to pretend to recall.

**A resumed run re-checks reality.** The plan is re-bound against the current
task, approvals, and Git baseline before anything continues. An obsolete plan
is never executed silently.

## What recovery reports

`orchestration_status <id>` — and `specbridge orchestrate show`/`explain` —
return:

- the current phase and what it is waiting on
- the active plan revision, and whether it is still fresh (with the reason if
  not)
- whether the plan was reviewed
- open clarification questions and decisions in force
- iteration, repair, replan, retry, and clarification counters against their
  budgets
- the recorded blocker and its remediation
- the interactive execution run the orchestration owns, its lifecycle status,
  and whether it still holds the repository lock
- current repository `HEAD`
- the latest checkpoint
- **the exact next safe action**

Reading a run never changes it. The transition to `REPLANNING` happens when
execution is next actually attempted, which is the moment it matters.

## Finalized runs

```text
resume a COMPLETED / ABORTED / CANCELLED / REJECTED run
   ↓
report the recorded outcome
   ↓
stop
```

There is no path back. Final phases have no outgoing transitions, so a
"continue" returns status rather than resuming execution, and the warning says
the run cannot be continued.

## Divergence

```text
resume
  ↓
detect divergence          task changed? stage re-approved? HEAD moved?
  ↓                        policy changed?
plan stale
  ↓
reconcile / replan
```

A changed **policy** is surfaced rather than silently applied: the run
continues under the budgets recorded at its start, and the report says the
configured policy has since changed. Enforcing different limits than the ones
a plan was reviewed under would make the review meaningless.

A lost or foreign **repository lock** on the owned interactive run is
reported with the safe path: abort that run (source changes are preserved),
then begin a fresh one.

## Checkpoints

A checkpoint is deliberately small — never a transcript:

```text
run id                     counters and budgets
task                       latest verifier state
phase                      blocker
current plan revision      the exact safe next action
completed plan steps
unresolved plan steps
relevant observations
```

Write one with `orchestration_checkpoint` before a long stretch of work and
whenever a session may be interrupted. A later session recovers *that* — a
compact, checkable statement of where things stand — rather than a story about
what a previous model was thinking.

## Relationship to `run recover-lock`

Unchanged. The repository lock, its staleness diagnosis, and
`specbridge run recover-lock` work exactly as they did in v1.0. Orchestration
does not introduce a second lock system; it records which interactive run it
owns and reports the existing lock's state.
