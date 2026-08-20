# The integration model and parallelism safety

## One writer, unchanged evidence

The canonical evidence path keeps exactly one writer. Parallel builders
mutate only their isolated worktrees; their output enters the canonical
tree exclusively through the single-writer integrator:

```text
Builder A ─┐
Builder B ─┼─→ verified candidate artifacts
Builder C ─┘
               ↓ structural aggregation (deterministic)
          INTEGRATOR — the single writer
               ↓
     canonical working tree
               ↓
 existing evidence pipeline (unchanged)
               ↓
     Objective completion
```

Integration runs **inside the existing interactive-run bracket** — the same
begin → mutate → complete pipeline the MCP task tools use — so the
repository lock, pre/post git snapshots, protected-path enforcement,
trusted verification, and verified-only checkbox completion are all the
unchanged machinery. Objective orchestration adds **no second completion
path**; only that canonical evidence completes the approved objective, and
the job folds the outcome through the same policy every executor dispatch
uses (diagnose → repair → replan → budgets).

The integrator applies verified candidate patches in dependency order
(`git apply --3way`). When a patch genuinely conflicts with the integrated
state, at most **one bounded reconciliation dispatch** may make minimal
integration edits — inside the same run bracket, so everything it does is
snapshotted and verified like any other change. The integrator may never
silently alter contracts, broaden scope, or override a failed candidate
evaluation; a failed integration aborts the run with all changes preserved
for diagnosis, and the objective fails honestly.

## Parallelism is opt-in and conservative

```json
{
  "orchestration": {
    "jobs": {
      "objectives": {
        "parallelism": { "enabled": false, "maxConcurrentBuilders": 3 }
      }
    }
  }
}
```

The default preserves the sequential behavior exactly. When enabled,
concurrent building is allowed only for READY units the deterministic
dispatch-set selection can **prove or conservatively establish**
independent:

- no dependency ordering requires serialization (only READY units qualify);
- pairwise-disjoint declared contract sets — two units independently
  working against the same authoritative contract never run together;
- pairwise-disjoint declared expected areas;
- a unit that declares neither contracts nor areas cannot prove
  independence from anything and runs alone;
- any unresolved decision or open conflict anywhere serializes everything.

**When uncertain: serialize — never guess parallel.**

Concurrency touches only the isolated builder dispatches. Graph writes stay
strictly sequential (prepare and fold phases), each parallel builder owns
its own worktree and scratch directory, and however many builders ran,
there is exactly **one** integration run — asserted by the parallel
end-to-end test.

## Events

The objective runtime emits bounded semantic events into the job's
append-only history — `workgraph_proposed/created/revised`,
`worker_started`, `candidate_ready/failed`, `evaluation_passed/failed`,
`contract_conflict_detected`, `contract_change_requested`,
`needs_decision`, `projection_stale`, `aggregation_completed`,
`integration_ready/started/failed`, `objective_verified` — never a
per-tool-call firehose. Detailed execution evidence stays where it already
lives: run records, snapshots, and verification logs.
