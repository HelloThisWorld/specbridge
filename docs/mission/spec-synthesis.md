# Mission → spec synthesis

When a mission reaches `CONTRACT_READY`, its contract set compiles into a
Kiro-compatible spec. Synthesis is a **deterministic compiler, not a
generator**: no model is invoked, every sentence in the produced documents
traces to a recorded mission artifact, and missing content means the mission
is not ready — never that something gets invented.

```bash
specbridge mission synthesize <missionId> [--spec-name <name>]
```

## What gets compiled

| Output | Compiled from |
| --- | --- |
| `requirements.md` | one `### Requirement N` per contract (dependency order); acceptance criteria from contract requirements and invariants; introduction from the goal; Out of Scope from non-goals; NFRs from constraints |
| `design.md` | overview from the goal and assumptions; Architecture from the Constitution; Components and Interfaces from the contracts; Error Handling and Security from topic-tagged decisions; Risks from ADRs |
| `tasks.md` | **Objectives**, one per contract, in dependency order |

The compiled candidates are archived under
`.specbridge/missions/<id>/spec-candidates/` (with `provenance.json` mapping
every requirement and criterion to `CTR-###/r###/R#` sources) *before* the
spec is created, then the spec is written through the existing atomic
creation machinery (`planSpecCreationFromFiles` → `executeSpecCreation`).
Synthesis never overwrites an existing spec; a name collision fails closed
and returns the mission to `CONTRACT_READY`.

## tasks.md means Objectives

For mission-driven projects, `tasks.md` deliberately contains
**objectives**, not microscopic coding instructions:

```markdown
- [ ] 1. Event-driven execution

  - Acceptance: An action request dispatch is supported for every workflow step.
  - Acceptance: An action result resumes exactly the execution that requested it.
  - Acceptance: An action result never carries a next-state directive.
  - Contract: CTR-003 r1
  - _Requirements: 1.1, 1.2, 1.3_
```

The approved objective is the human contract; **how** it is implemented is
the autonomous runtime's job (see
[objective decomposition](../orchestration/objective-decomposition.md)).
Objectives are leaf checkbox tasks — acceptance criteria are plain notes, so
the existing task parser, traceability, and evidence pipeline treat one
objective as one completable unit.

## Validation and approval

Compiled candidates are validated structurally before anything is written
(requirements must parse with criteria; tasks must parse as leaf checkboxes)
and the created spec passes the existing stage analyzers with zero
error-severity findings — asserted by tests.

Approval is untouched and human-only:

```bash
specbridge spec approve <spec> --stage requirements
specbridge spec approve <spec> --stage design
specbridge spec approve <spec> --stage tasks
```

`specbridge mission show` (and the plugin) observe the approvals: when every
stage is approved through the normal workflow, the mission records
`APPROVED`. Nothing in the mission layer can perform an approval, and
re-approval invalidation, staleness detection, and the byte-identical `.kiro`
round trip all apply to a synthesized spec exactly as to a hand-written one.
