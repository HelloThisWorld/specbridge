# Architecture Constitution and ADRs

## The Constitution

The Architecture Constitution is a **small set of strong, durable
invariants** — the sentences every future worker must never contradict.
For StepRelay it looks like:

```text
CON-001 Workflow definition is the sole authority for control flow.
CON-002 Actions never determine workflow transitions.
CON-003 Broker-specific semantics cannot leak into the canonical runtime model.
CON-004 Duplicate external results must be safe.
CON-005 Late results must not resurrect terminal state.
CON-006 Aggregation order must not depend on arrival order.
```

Every rule carries a stable id (`CON-###`), a version, a status
(`active` / `superseded`), provenance (`decisionIds`, `turnIds` — a rule
must trace to at least one recorded decision), and the contracts it
constrains. The whole constitution lives in `constitution.json` with a
monotonic document version that bumps on every change; superseded rules stay
in the file, so history is never rewritten.

The bound is structural: the schema caps active rules, because a
constitution with forty rules is a design document, not a constitution.

### Guard patterns: machine-checkable invariants

A rule (and a contract invariant) may declare bounded `guardPatterns` —
regular-expression sources that the **deterministic** candidate evaluator
greps against the *added lines* of every candidate diff. A hit is a
structural constitution violation and becomes a `CONTRACT_CONFLICT` with no
model judgment involved:

```json
{
  "statement": "Actions never determine workflow transitions.",
  "guardPatterns": ["nextState\\s*[:=]"]
}
```

is exactly how "a worker proposed putting `nextState` into `ActionResult`"
is caught deterministically. Patterns are compile-validated when recorded
and bounded in count and length.

### Where the constitution travels

Every worker's [context projection](../orchestration/context-projection.md)
carries the **whole active constitution** — it is small by design and
binding for everyone — while contracts, ADRs, and decisions are filtered to
what the work unit declares relevant.

## ADRs

Architecture Decision Records capture the material trade-offs behind the
constitution and contracts:

- `adrId` (`ADR-####`), title, context, decision, alternatives, rationale,
  consequences, revisit conditions;
- provenance (`decisionIds` and/or `turnIds` — at least one is required);
- supersession lineage (`supersedes`).

ADR files are **immutable once written**. Old ADR history is never
rewritten when decisions change: a later ADR names the one it replaces in
`supersedes`, and the effective status (`accepted` / `superseded`) is
*derived at read time*. `specbridge mission adr <id>` shows both.

## Recording

Rules and ADRs are proposed through `mission_assess` (typically by the
`/specbridge:discover` skill as decisions crystallize) and validated by
SpecBridge: missing provenance, references to superseded decisions, invalid
guard patterns, and bound violations are refused with stable `SBM###`
errors. Ids are assigned by SpecBridge — a caller can never choose or reuse
one.
