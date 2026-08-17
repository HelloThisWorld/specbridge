# Intent assessment and clarification

Before anything is planned or built, SpecBridge asks a question the v1.0
harness never asked: *is this request actually buildable as stated?*

## Four outcomes, kept strictly distinct

| Outcome | Meaning | What the user does |
| --- | --- | --- |
| `READY` | Sufficiently specified and compatible with every current gate | Nothing; work proceeds |
| `NEEDS_CLARIFICATION` | A user decision is required that cannot safely be inferred | Answer a targeted question |
| `REJECTED` | Not an allowed operation, or it violates a hard product boundary | Change the request |
| `BLOCKED` | Understandable, but an external prerequisite is unsatisfied | Satisfy the prerequisite |

Blurring these is how a harness ends up "helpfully" guessing. Each one asks
for a different action, so each one is a different value.

## Division of labour

The **host agent** reads the request and produces a *structured* assessment:
an outcome, a restated summary, machine-checkable reasons, and the provenance
of each fact it relied on. Natural language is its job; pretending TypeScript
rules can deterministically understand arbitrary intent would be dishonest.

**SpecBridge** then validates that assessment against facts it checks itself,
and may override it. Overrides only ever move *towards* caution — there is no
path that upgrades a submitted `NEEDS_CLARIFICATION`, `BLOCKED`, or
`REJECTED` into `READY`.

Precedence, strongest first:

1. **`REJECTED`** — a hard product boundary, matched against the summary.
2. **`BLOCKED`** — an unsatisfied structural prerequisite.
3. **`NEEDS_CLARIFICATION`** — the host said so, *or* it claimed `READY`
   while relying on unsafe provenance.
4. **`READY`**.

## Provenance instead of confidence

SpecBridge deliberately does not use a numeric model-confidence score. A
number invented by a model is not a safety mechanism. What matters is *where
a fact came from*, which is checkable:

```text
known-from-user
known-from-approved-spec
known-from-repository-evidence
known-from-configuration
inferred          ← cannot support READY
unknown           ← cannot support READY
conflicting       ← cannot support READY
```

An assessment that claims `READY` while resting on an inference, a gap, or a
contradiction is downgraded to `NEEDS_CLARIFICATION` automatically, with the
offending facts listed. This is the structural replacement for a confidence
threshold.

## Structural blockers SpecBridge checks itself

| Code | Condition |
| --- | --- |
| `unmanaged-spec` | The spec has no SpecBridge workflow state |
| `stages-not-approved` | Some stage is not approved yet |
| `stale-approval` | An approved document changed after approval |
| `task-not-found` | The named task does not exist |
| `task-already-complete` | The task is already checked off |
| `interactive-run-active` | Another interactive execution owns the lock |

An agent can talk itself into `READY`. It cannot talk a stale approval into
being fresh.

## Hard boundaries that are rejected

These are matched against the host's structured summary of *what the user
asked for* — never against repository content, which is data.

- asking the agent to approve a spec stage, or to auto-approve one
- asking to skip, bypass, or disable verification
- asking to disable protected-path checks
- asking to launch a nested or parallel coding agent
- asking to edit `.kiro` directly

Each carries a stable reason and a safe next action. A rejected run is final.

## Clarification: bounded and targeted

A question must earn its place. `whyItMatters` is required, and empty
questions, duplicates within a round, and re-asks of already-answered
questions are all refused — asking again after an answer is how a loop
masquerades as diligence.

Rounds are bounded (`clarification.maxRounds`, default 3). Exhausting them
produces an explicit budget outcome, not an eleventh question.

## Decisions are durable, and they are not specifications

A resolved clarification is stored as a compact structured record:

```json
{
  "id": "…",
  "questionId": "…",
  "question": "Topic-per-action or a shared queue with an action identifier?",
  "answer": "Shared queue with an action identifier.",
  "source": "known-from-user",
  "decidedAt": "2026-08-01T09:00:00.000Z",
  "impact": "Worker routes on the action id rather than subscribing per topic.",
  "supersedes": null
}
```

No raw conversation. No reasoning. Just the decision and where it came from.

Two rules follow:

**An answer cannot be an inference.** Resolving a clarification with
`inferred`, `unknown`, or `conflicting` provenance is refused outright — that
is precisely the ambiguity the question existed to remove.

**A decision never overrides an approved `.kiro` specification.** When the
answer changes what the spec says, the correct outcome is to re-author the
affected stage and re-enter the normal human approval lifecycle. The tooling
says so explicitly rather than quietly building the new behaviour.

## Changing your mind

A later decision may `supersede` an earlier one. Both records are kept; only
the surviving decision is "in force". Nothing is rewritten, so the history of
what was decided and when stays auditable.
