# ReAct/TAO execution discipline

SpecBridge runs the agent's work through a structured, externalized
observe → decide → act → observe loop. The loop is bounded, recorded, and
resumable.

It is **not** a request for the model's reasoning.

## What is recorded

Each iteration records an operational tuple:

```text
action category       INSPECT | EDIT | TEST | VERIFY | REPLAN |
                      REQUEST_CLARIFICATION | ABORT | COMPLETE
target                a path, a verifier name, a step id
plan step             which plan step this serves
expected evidence     what would show the step succeeded
result                progressed | no-change | failed
failure               category, source, exit code, normalized output
changed files         observed paths and content hashes (claims)
```

From that, SpecBridge computes the observation fingerprint, the progress
assessment, and the deterministic next directive. The agent does not choose
the directive; it reads it.

```text
OBSERVE
   ↓
DECIDE               ← SpecBridge, from policy + counters + fingerprints
   ↓
ACT                  ← the agent
   ↓
OBSERVE
   ↓
progress?
   ├─ yes     → CONTINUE
   ├─ ready   → VERIFY      (task_complete decides, not the assertion)
   ├─ failed  → REPAIR / RETRY
   ├─ invalid → REPLAN
   ├─ missing → CLARIFY / BLOCK
   └─ spent   → STOP_BUDGET_EXHAUSTED
```

## Why no chain-of-thought is stored

Interpreting ReAct or TAO as "make the model write down its reasoning and keep
it" would be the wrong lesson for a governance harness, for four reasons.

**It would not be evidence.** A recorded rationale is another model output.
SpecBridge's central rule is that model output is never authoritative
evidence; storing more of it does not make any of it more trustworthy. What
makes a claim checkable is the Git diff, the verifier exit code, and the
approved-hash binding — none of which needs a narrative.

**It would not be operational.** The harness needs to answer "may this action
proceed, and what happens next?" That is decided by phase, plan freshness,
failure category, counters, and fingerprints. A paragraph of deliberation
contributes nothing to that decision, so persisting it would add risk without
adding control.

**It would create a data-handling liability.** Reasoning text is unbounded,
unpredictable, and regularly contains fragments of source files, environment
details, and pasted user content. Persisting it into an append-only sidecar
means those fragments are retained, replicated, and surfaced by every status
view — with no way to know in advance what ended up in there.

**It would invite a false audit trail.** A stored rationale reads like an
explanation of what happened. It is not: it is what a model said at the time,
which may not describe what it actually did. Structured decisions with
provenance are auditable precisely because they are narrow enough to check.

So the schemas have no field for it. `intent`, `decisions`, `plans`, and
`events` are all structured records, and the tests assert that no
`reasoning`, `chainOfThought`, `transcript`, or `promptText` key exists in
persisted state.

A resumed session therefore cannot pretend to remember the previous model's
private reasoning — there is nothing to remember, which is the honest state of
affairs either way.

## What the agent still gets to do

Everything that actually requires a model: reading the request, investigating
the repository, proposing an interpretation, drafting a plan, writing the
code, diagnosing a failure, and deciding what to change next. The harness does
not second-guess any of that. It bounds it, records what was attempted, and
decides — from evidence — whether the result counts.

## Action gating

Every state transition validates whether the attempted action is allowed in
the current phase, and the table fails closed:

- a source edit before required plan approval → refused
- `COMPLETE` before execution started → refused
- any action against a finalized run → refused (status only, never new work)
- a replan after completion → refused
- a retry after cancellation → refused without an explicit new operation

See [agent-orchestration.md](agent-orchestration.md) for the full phase and
action tables, and
[enforcement-boundaries.md](enforcement-boundaries.md) for which of these are
hard-enforced versus instructed.
