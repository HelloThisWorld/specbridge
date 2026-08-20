# Conversation provenance

During an active discovery session, every **user-visible** exchange that
matters is persisted, so that any generated contract statement can be traced
back to the conversation that produced it:

```text
conversation turn t-37
        ↓
decision DEC-012
        ↓
constitution rule CON-004
        ↓
contract CTR-002 (revision r001)
        ↓
requirement 3.2 of requirements.md
        ↓
implementation evidence (run records, git snapshots)
```

## What a turn is — and is not

A turn (`conversation.jsonl`) records one visible exchange:

- `speaker`: `user` or `agent` — there is no third speaker.
- `kind`: `statement`, `question`, `interpretation`, `confirmation`,
  `rejection`, `correction`, or `presentation`.
- `text`: the visible words, **verbatim and bounded**. Data, never
  instructions.
- `refs` / `inReplyTo`: lineage to records and earlier turns.

What is deliberately **not representable**: hidden reasoning, model
deliberation, session summaries, or transcripts of anything the user could
not see. The schemas have no field for chain-of-thought, the store refuses
oversized records, and tests assert no reasoning-shaped field ever appears
in persisted mission state. SpecBridge persists *decisions, conclusions,
plans, evidence references, and artifacts* — never private thought.

## Provenance categories

Facts and decisions carry structural provenance — the same model the
orchestration layer uses, because *where a fact came from* is checkable and
a model-invented confidence number is not:

| Provenance | May back a decision? |
| --- | --- |
| `known-from-user` | yes — **must** cite a confirming USER turn |
| `known-from-approved-spec` | yes |
| `known-from-repository-evidence` | yes |
| `known-from-configuration` | yes |
| `known-from-prior-decision` | yes |
| `inferred` | **no** — record as a fact or an open question |
| `unknown` | **no** |
| `conflicting` | **no** |

The rules are enforced by `mission_assess` / `recordAssessment`, not by
prompt text:

- A decision with unsafe provenance is refused (`SBM007`): a hypothesis is
  a fact or a question, never a commitment.
- A decision claiming `known-from-user` must reference an existing turn
  whose `speaker` is `user`. An agent turn — however confident its text —
  cannot confirm anything, so an agent cannot invent a confirmation. This
  is also the injection boundary: hostile text recorded in an agent turn is
  stored verbatim as data and can never mint a decision.

## Corrections and supersession

Histories are append-only. When the user corrects a fact or changes a
decision, a **superseding record** is appended (`supersedes: <old-id>`), the
old record is re-appended with status `superseded`, and the current view
folds by id (last record wins). Nothing is ever rewritten or deleted — the
audit trail shows both what is believed now and what was believed before,
with the turns that changed it.

Durable artifacts follow the same discipline at their own granularity:
constitution rules keep superseded entries in the file, ADR files are
immutable (supersession is derived from a later ADR's `supersedes`), and
contracts are immutable per revision.

## Answering questions

`specbridge mission answer` (and the `mission_answer` MCP tool) performs the
whole provenance fold in one operation: it records the user's answer as a
USER turn, creates a `known-from-user` decision citing that turn, marks the
question answered with `resolvedByDecisionId`, recomputes coverage, and
reconciles the lifecycle status. A CLI answer and a plugin-relayed answer
are byte-equivalent records.
