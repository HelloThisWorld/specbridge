# Governed agent orchestration

The v1.1 capability that governs **how** a coding agent reaches a result —
not just what it is allowed to execute and whether the result counts as
complete.

SpecBridge v1.0 already controlled the endpoints well: approvals gate what
may run, and Git evidence plus trusted verification commands decide whether a
task is done. What it did not control was the middle. An agent could
implement an underspecified requirement, silently pick between two valid
architectures, retry a deterministic failure forever, broaden scope while
debugging, or present a fresh run as a continuation.

v1.1 adds a bounded, observable, resumable control loop around that middle.

```text
User goal
   ↓
Intent assessment        →  READY | NEEDS_CLARIFICATION | REJECTED | BLOCKED
   ↓
Approved specification state
   ↓
Execution planning
   ↓
Plan review gate
   ↓
Bounded Observe → Decide → Act → Observe loop
   ↓
Fresh evidence
   ↓
Repair / retry / replan / clarify / abort
   ↓
Trusted verification
   ↓
Evidence-backed completion
```

## The separation that makes it work

SpecBridge is **not** an autonomous coding agent, and v1.1 does not make it
one. The goal of this milestone is not more agent autonomy; it is more
reliable, observable, bounded, and governable agent execution.

```text
SpecBridge owns          state, contracts, policy, boundaries, approvals,
                         task identity, the planning lifecycle, the execution
                         lifecycle, retry policy, budgets, evidence,
                         verification, and the completion decision

The coding agent owns    interpretation proposals, candidate plans,
                         repository investigation, source edits, test fixes,
                         implementation actions

Git + trusted            observable implementation evidence
verification own
```

Model output is never authoritative evidence. It is a *claim*, recorded as
one.

## Where it lives

`@specbridge/orchestration` is a reusable domain package. The CLI, the MCP
server, and the Claude Code plugin are thin adapters over it — none of them
re-implements a state transition, a budget, a retry rule, a freshness check,
or a completion decision.

| Layer | Responsibility |
| --- | --- |
| `@specbridge/orchestration` | The state machine, taxonomies, policy, and persistence |
| `specbridge orchestrate …` | Deterministic read-only inspection |
| MCP `orchestration_*` tools | The operations an agent host needs to participate |
| `/specbridge:develop` | How to talk to the user while doing it |

## The lifecycle

Twelve phases, chosen so a run can only be *in* a phase it could genuinely be
resumed in. Intent assessment, plan validation, and verification all complete
inside a single call, so they are transitions rather than phases.

```text
CREATED ─────────────┬─→ NEEDS_CLARIFICATION ──┐
                     │                          │
                     ├─→ READY_TO_PLAN ←────────┘
                     │        ↓
                     │   AWAITING_PLAN_REVIEW
                     │        ↓
                     │   READY_TO_EXECUTE
                     │        ↓
                     │     EXECUTING ⇄ REPAIRING
                     │        ↓          ↓
                     │     REPLANNING ←──┘
                     │        ↓
                     ├─→ BLOCKED (recoverable, but only explicitly)
                     │
                     └─→ COMPLETED | ABORTED | CANCELLED | REJECTED  (final)
```

Every transition is validated against a frozen table and **fails closed**: a
transition that is not explicitly listed is refused. Final phases have no
outgoing transitions at all — a "continue" against a finished run returns
status, it never resumes execution.

A second table governs which *actions* are legal in each phase. This is what
makes "no source edits before the plan gate" a hard-enforced rule rather than
an instruction in a Markdown file: `EDIT` simply is not in the allowed set for
`CREATED`, `NEEDS_CLARIFICATION`, `READY_TO_PLAN`, `AWAITING_PLAN_REVIEW`,
`REPLANNING`, or `BLOCKED`.

## What is stored, and what is not

Orchestration state lives under `.specbridge/orchestration/<id>/`:

```text
state.json          versioned state record (atomic write)
events.jsonl        append-only history
plans/0001.json     every plan revision, kept forever
checkpoint.json     the latest structured checkpoint
```

`.kiro` is untouched. No orchestration metadata — no front matter, no hidden
comments, no execution ids, no model metadata, no retry counters — ever
appears in a Kiro document. The byte-preservation and zero-migration
guarantees are unchanged.

Nothing here stores private model reasoning. There is no field for it in any
schema, and the tests assert its absence. See
[ReAct/TAO execution discipline](react-tao-execution.md) for why a harness
needs operational control rather than a transcript of deliberation.

## Reading more

- [Intent and clarification](intent-clarification.md)
- [Execution planning](execution-planning.md)
- [Retry and repair](retry-and-repair.md)
- [ReAct/TAO execution discipline](react-tao-execution.md)
- [Orchestration recovery](orchestration-recovery.md)
- [Enforcement boundaries](enforcement-boundaries.md) — what is actually
  enforced, and what is only instructed
