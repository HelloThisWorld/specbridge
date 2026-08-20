# Sub-agent isolation: the supervisor, worker identity, and worktrees

## Worker identity

Every objective worker attempt gets a durable identity record **before** it
runs:

```text
workerId               builder-wu-2-a1
agentRole              BUILDER | DECOMPOSER | EVALUATOR | AGGREGATOR | INTEGRATOR
workUnitId / attempt   wu-2 / 1
contextProjectionHash  what approved truth it was given
contractSnapshotHash   which contract revisions that truth reflected
workspaceIdentity      worktree:wu-2-a01 | canonical | ephemeral
status                 RUNNING → FINISHED | FAILED | SUPERSEDED
budget                 timeoutMs (and output bounds)
```

A result is accepted only when it presents the identity of the RUNNING
record for its work unit and attempt. The acceptance guard
(`acceptWorkerResult`) fails closed on every mismatch, each exercised by a
dedicated test:

- unknown work unit, or no worker record (never dispatched);
- wrong `workerId` — **a result delivered to the wrong identity is rejected
  even if its content looks valid**;
- duplicate result (the attempt already FINISHED);
- late result from a SUPERSEDED attempt or a superseded work unit;
- projection or contract-snapshot hash mismatch (stale or forged context);
- a second worker trying to begin an attempt that is RUNNING or FINISHED —
  two workers can never own one work-unit attempt.

## No peer-to-peer conversation

Workers never message each other. The only communication path is:

```text
Worker → structured artifact / event → SpecBridge → another worker's context projection
```

This is structural, not policy: worker outputs are schema-validated
documents with no field for conversation, projections are built exclusively
from stored approved artifacts, and packets state that fenced content is
data. Reasoning and evaluation workers are ephemeral and read-only
(`inspect-only` tool policy).

## Isolated worktrees

Implementation work that runs independently gets an **isolated git
worktree** per `(workUnit, attempt)` under
`.specbridge/jobs/<jobId>/worktrees/` — inside the sidecar, excluded from
evidence snapshots, path-checked:

- created detached at the canonical HEAD; verified dependency patches are
  applied on top (`git apply --3way`), so dependents build on their
  prerequisites' candidates;
- the builder's whole world is this directory: its invocation runs with the
  worktree as working directory and the configured implementation tool
  policy — the same policy task execution already uses, no wider;
- it never pushes, never merges, never mutates the canonical checkout: the
  worktree is a **candidate workspace, never the source of completion
  truth**;
- SpecBridge observes reality itself: `git status`/`git diff --binary`
  against the **recorded baseline commit** — so even a worker that commits
  locally cannot hide changes — plus the trusted verification commands run
  inside the worktree;
- candidates touching `.kiro/`, `.specbridge/`, or configured protected
  paths are refused at collection time;
- removal is forced and idempotent; on resume, interrupted worktrees are
  pruned, their RUNNING workers marked SUPERSEDED (late results refused),
  and their units returned to the safe predecessor state with the attempt
  consumed.

## Budgets and accounting

Every objective worker dispatch — decomposer, builder, evaluator,
aggregator, integrator reconciliation — is folded into the job's attempt
history and counts against the same `maxAgentRuns` budget as every other
worker, with provider-reported usage accumulated identically. Budget
exhaustion mid-objective stops the objective and blocks the job honestly.
