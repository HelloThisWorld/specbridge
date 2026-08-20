# Evaluation and aggregation

## Candidate artifacts

A builder returns a **durable candidate artifact**, never chat:

- observed changed files and a normalized binary-safe patch — computed by
  SpecBridge from the worktree against the recorded baseline commit;
- local verification results (the trusted configured commands, run inside
  the worktree by SpecBridge);
- the projection and contract-snapshot hashes the attempt was bound to;
- the worker's structured **claims**: summary, discovered assumptions,
  contract change requests, known limitations, and (for investigations) the
  report body.

Claims are data. The result schema deliberately has no field that could
encode commands, permissions, or authority — unknown fields are ignored,
and a candidate claiming completion claims a *candidate*, nothing more.

## Layer 1: deterministic evaluation (always first)

Where a deterministic answer exists, no model is consulted. Every candidate
passes named checks, recorded verbatim in the evaluation record:

| Check | Fails when |
| --- | --- |
| `identity-binding` | the candidate presents different hashes than its attempt was given |
| `protected-paths` | the diff touches `.kiro/`, `.specbridge/`, or configured protected paths |
| `projection-freshness` | a referenced contract gained a revision (stale context → replan) |
| `local-verification` | the trusted commands failed inside the worktree |
| `non-empty-change` | a build candidate changed nothing |
| `scope` | every changed file falls outside the declared expected areas |
| `contract-guards` | an **added** diff line matches a constitution/contract guard pattern |

A guard hit is not a FAIL but a **CONFLICT** — approved architecture is
contradicted, which is an authority question, not a quality question. The
StepRelay `nextState`-inside-`ActionResult` scenario is caught exactly here,
with zero model involvement.

## Layer 2: semantic evaluation (where judgment is genuine)

Policy (`orchestration.jobs.objectives.semanticEvaluation`):

- `auto` (default) — investigations always; build candidates only when they
  declare assumptions, change requests, or limitations the deterministic
  layer cannot judge;
- `always` / `disabled`.

The EVALUATOR (local-first; HIGH complexity escalates) receives the
approved contract projection + the candidate diff + the deterministic
evidence + one question — never any worker conversation. Its verdict is
schema-constrained:

- `PASS` → verified candidate;
- `FAIL` → bounded retry, then unit failure;
- `CONFLICT` → a contract-conflict record;
- `NEEDS_DECISION` → routed by decision kind through the existing authority
  table: implementation-detail resolves autonomously (recorded); public
  API / architecture / protocol / product behavior stops for the human.

A worker is never the sole evaluator of its own work: the evaluator is a
separate ephemeral invocation with its own identity, packet-built from
stored artifacts only. Evaluator verdicts feed aggregation — they complete
nothing.

## Contract conflicts

When work contradicts an approved contract — a guard hit, an evaluator
CONFLICT, or contradicting aggregated reports — a first-class
`CONTRACT_CONFLICT` record is stored: the contract id and revision, every
claim with its source work unit, evidence references, affected units, and
the decision kind. Nothing ever silently picks a side; material kinds block
the unit and surface as a job clarification for the human.

## Aggregation: structural, then semantic

**Structural aggregation is deterministic and always runs.** Integration is
ready exactly when every required (non-integration, non-superseded) unit
holds a `VERIFIED_CANDIDATE`; a FAILED or BLOCKED required unit makes the
objective structurally unable to integrate:

```json
{ "runtime": "VERIFIED_CANDIDATE", "transport": "VERIFIED_CANDIDATE", "sdk": "FAILED" }
→ the objective cannot integrate (no model needed)
```

**Semantic aggregation runs only when several verified investigation
reports genuinely require synthesis** (two or more). One bounded AGGREGATOR
dispatch produces a structured report — findings attributed to their source
units, an optional recommendation, contract-change *suggestions* (which
become CCRs, never approvals), and cross-report conflicts (which become
contract-conflict records and stop integration for a decision). A failed
aggregator worker is recorded and integration proceeds on the deterministic
result: synthesis is additive insight, never a gate.
