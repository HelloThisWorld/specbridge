# Execution planning

An execution plan answers a different question from `tasks.md`.

| | `tasks.md` | Execution plan |
| --- | --- | --- |
| Question | *Which* implementation tasks exist | *How* the selected task will be approached |
| Owner | Human, approved | Agent-proposed, SpecBridge-validated |
| Lives in | `.kiro/specs/<name>/tasks.md` | `.specbridge/orchestration/<id>/plans/` |
| Scope | The whole feature | One task, against *this* repository state |
| Changes | Re-authored and re-approved | Replanned within a budget |

Plans never go into `.kiro`.

## What a plan contains

```text
plan schema version        goal
plan id                    non-goals
revision                   constraints
spec name                  relevant evidence
task fingerprint           assumptions          ← labelled as assumptions
approved spec hashes       open questions
repository baseline        expected areas       ← planning info, not a fact
policy fingerprint         ordered steps
                           test strategy
                           verification strategy
                           rollback considerations
                           replan triggers
```

Agents are not asked to predict every changed filename with certainty.
Expected areas are planning information; presenting them as facts would be a
fabrication, so the schema and the docs both call them what they are.

## Binding: what makes a plan go stale

A plan is bound to the context it was created against, reusing primitives that
already exist rather than inventing parallel notions of "the same task":

- the **task fingerprint** from `@specbridge/compat-kiro`
- the **approved stage hashes** from the spec state
- the **Git baseline** (`HEAD`) from the evidence snapshot
- the **policy fingerprint** of the orchestration budgets

A plan becomes stale when any of them changes:

| Reason | Meaning |
| --- | --- |
| `task-fingerprint-changed` | The task's title or requirement references changed |
| `approved-stage-changed` | An approved document changed, or a new stage was approved |
| `repository-baseline-changed` | `HEAD` moved under the run |
| `policy-changed` | The budgets the plan was reviewed under changed |
| `superseded` | A newer revision replaced it |

**A stale plan is never executed silently.** Inspecting a run reports
staleness without changing anything; the first *mutating* action moves the run
to `REPLANNING` and refuses the edit. Looking at a run never changes it.

## The review gate

`orchestration.planning.mode` controls it:

| Mode | Behaviour |
| --- | --- |
| `review` (default) | The plan must be presented and explicitly confirmed before the first implementation mutation |
| `auto` | Explicit opt-in for lower friction *after* the spec and task already passed human approval. A plan is still required, still recorded, and material replanning is still surfaced |
| `disabled` | No plan is required. This disables **nothing else**: approvals, evidence, verification, protected paths, and budgets all still apply |

`disabled` exists so the historical `/specbridge:implement` lifecycle keeps
its exact behaviour. It is not a hidden way to bypass governance — every other
gate is untouched, and `specbridge orchestrate policy validate` says so out
loud.

A recorded review is bound to the **exact plan hash**. A review cannot carry
over to a plan the user never saw.

## Replanning

Submitting a plan again is a replan. It records a new revision, supersedes the
previous one, and increments the replan counter (bounded by
`planning.maxReplans`, default 2). Every revision is kept.

Replanning is the right response to: an expected API that does not exist,
architecture that differs from the plan's assumptions, a test failure that
reveals a different root cause, work that needs scope outside the approved
task, an unavailable dependency, a planned edit that would violate a boundary,
changed repository state, or repeated actions that produce no progress.

### Material vs immaterial

The user must not be dragged back into a review for a formatting change, and
must always be asked about a change of strategy.

**Material** (a prior review no longer applies):

- the task changed
- the goal or a non-goal changed
- the expected implementation areas changed (a different subsystem)
- the constraints changed
- the test or verification strategy changed
- the set of steps changed in content

**Immaterial** (the review stands):

- step reordering
- wording and whitespace edits
- added or removed evidence notes, assumptions, or open questions
- step status progress

A material change clears the recorded review and returns the run to
`AWAITING_PLAN_REVIEW`. An immaterial one leaves the run executable.

## Bounds

| Setting | Default | Effect |
| --- | --- | --- |
| `planning.maxReplans` | 2 | Replans per run |
| `planning.maxPlanSteps` | 40 | Steps in one plan |
| `planning.maxPlanBytes` | 65536 | Serialized plan size |

A plan over the step budget usually means the *task* should be split; the
error says so.
