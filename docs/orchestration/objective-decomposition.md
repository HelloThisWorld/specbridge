# Objective decomposition: the dynamic work graph

For a mission-driven spec, each approved leaf task of `tasks.md` is an
**Objective** — the human contract. The objective runtime adds an internal
level between the objective and worker dispatches:

```text
Approved Objective (one leaf task, human-approved)
        ↓ DECOMPOSER proposes; SpecBridge validates
Dynamic Work Graph (runtime state only — never in .kiro)
        ├── Work Unit A   (build)
        ├── Work Unit B   (build)
        ├── Work Unit C   (investigation)
        └── Integration Unit
```

Work units are **runtime-internal decomposition**: their ids never appear in
approved documents, and no revision of the graph can change *which*
objective is being implemented — the graph binds to the objective's task
fingerprint, and a changed objective makes the whole graph stale.

## The DECOMPOSER proposes; validation decides

The DECOMPOSER (routed to the large agent by default — decomposition is
architecture-sensitive) receives the objective's
[context projection](context-projection.md) and returns a structured
proposal: `WORK_GRAPH`, `SINGLE_UNIT`, or `ESCALATE`. The model never owns
concurrency, ordering, or scope authority. Deterministic validation
(`validateWorkGraphProposal`) refuses — never repairs — proposals that:

- exceed the unit-count or dependency-depth bounds
  (`orchestration.jobs.objectives.maxWorkUnits` / `maxGraphDepth`);
- contain cycles, unknown dependencies, duplicates, or self-loops;
- have several build units without a terminal integration unit fed by all
  of them;
- give the integration unit dependents (it must be terminal).

Shared contract ownership between build units is surfaced in the recorded
validation notes — such units never build in parallel.

**Decomposition is an optimization, never a dependency.** Any decomposer
failure, escalation, or refused proposal degrades to the deterministic
single-unit graph (the whole objective as one build unit), and the pipeline
proceeds. A model outage cannot stall an objective.

## Work-unit lifecycle

```text
PLANNED → READY → BUILDING → CANDIDATE_READY → (EVALUATING) →
VERIFIED_CANDIDATE → INTEGRATED
```

with `REJECTED` (bounded retry), `BLOCKED` (needs a decision), `FAILED`,
and `SUPERSEDED` (replaced in a later graph revision). The table is frozen
and fail-closed; two edges carry the architecture:

- `INTEGRATED` is reachable **only** from `VERIFIED_CANDIDATE` — nothing
  enters the canonical tree without passing evaluation, structurally.
- `VERIFIED_CANDIDATE` is reachable only from evaluation statuses — a unit
  can never be born verified.

Build units normally use the large-agent builder. Phase 4 also provides an
explicit-only [Secondary Objective Builder](secondary-objective-builder.md):
a direct model returns bounded structured edits which SpecBridge applies in
the same isolated worktree and feeds into this exact lifecycle. Merely enabling
local inference does not select that backend.

## Runtime replanning within the objective

Within one approved objective the runtime may split, merge, supersede, or
add work units and change dependencies — graph revisions are append-only
documents with full lineage (`workgraphs/0001.json`, `0002.json`, …), and a
superseded unit's replacement carries `supersedes` back to it. What it may
**never** silently do: alter approved product behavior, architecture
contracts, acceptance criteria, public API, or protocol semantics — those
surface as contract conflicts or change requests and stop for the human
(see [evaluation and aggregation](evaluation-and-aggregation.md)).

## How objectives plug into jobs

The objective pipeline replaces exactly one step of the v1.2 job driver:
the executor dispatch. When the spec is mission-linked (and
`orchestration.jobs.objectives.enabled` is true), `DISPATCH_EXECUTOR` routes
into the objective driver, which returns the same outcome shape the direct
executor returns. Everything above it — diagnosis before repair, replans
with supersession, budgets, no-progress detection, clarifications, resume —
is the unchanged job machinery. Legacy specs keep the direct executor path
byte-identical.

Inspect at any depth:

```bash
specbridge orchestrate objective <jobId> <nodeId>
specbridge orchestrate workunit <jobId> <nodeId> <workUnitId>
```

or over MCP: `objective_read`, `workunit_read`, `evaluation_read`.
