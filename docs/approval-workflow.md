# Approval workflow (`spec approve`, `spec status`)

SpecBridge treats approval as an explicit, recorded decision — never an
inference. A stage is approved only when sidecar state says so; a file
existing (or looking finished) proves nothing.

```sh
specbridge spec approve notification-preferences --stage requirements
specbridge spec approve notification-preferences --stage design
specbridge spec approve login-timeout-fix --stage bugfix
specbridge spec approve notification-preferences --stage requirements --revoke
specbridge spec status notification-preferences
```

## Workflow state machines

Statuses advance as stages are approved. `spec status` shows the effective
status; `STALE_APPROVAL` appears when a recorded approval no longer holds.

| Workflow | Statuses |
| --- | --- |
| Feature, requirements-first | `REQUIREMENTS_DRAFT → REQUIREMENTS_APPROVED → DESIGN_DRAFT → DESIGN_APPROVED → TASKS_DRAFT → READY_FOR_IMPLEMENTATION` |
| Feature, design-first | `DESIGN_DRAFT → DESIGN_APPROVED → REQUIREMENTS_DRAFT → REQUIREMENTS_APPROVED → TASKS_DRAFT → READY_FOR_IMPLEMENTATION` |
| Quick | `READY_FOR_REVIEW → READY_FOR_IMPLEMENTATION` |
| Bugfix | `BUGFIX_DRAFT → BUGFIX_APPROVED → DESIGN_DRAFT → DESIGN_APPROVED → TASKS_DRAFT → READY_FOR_IMPLEMENTATION` |

In practice a `<STAGE>_APPROVED` status is transient: approving a stage
immediately unblocks the next one, whose draft status takes over. The
`_APPROVED` values remain valid stored states (hand-edited or reconstructed
state can express them).

## Prerequisites

| Workflow | Rule |
| --- | --- |
| requirements-first | requirements → design → tasks, strictly in order |
| design-first | design → requirements → tasks, strictly in order |
| quick | requirements and design in either order; tasks needs both |
| bugfix | bugfix → design → tasks (design-first bugfixes start with the fix design) |

An approval is blocked (exit `1`) when a prerequisite is unapproved **or**
approved-but-stale, when deterministic analysis of the stage reports errors
(unresolved placeholders included), or — for tasks — until every earlier
stage holds. Warnings never block. Usage mistakes (unknown spec, stage that
does not exist for the spec type) exit `2`.

## What approval records

Approval hashes the **exact file bytes** (SHA-256 — CRLF vs LF, BOMs, and
trailing newlines all count) and stores hash + timestamp in
`.specbridge/state/specs/<name>.json`. The Markdown file itself is never
rewritten, reformatted, or annotated.

## Stale approvals

Every read of a managed spec (`spec status`, `spec list`, `spec show`,
`doctor`, and the gates inside `spec approve`/`spec analyze`) re-hashes the
approved files:

- a changed file → effective status `modified-after-approval`
- approvals that depended on it → effectively stale too
- the overall effective status → `STALE_APPROVAL`

Read-only commands only *report* this — they never rewrite state. The repair
is an explicit re-approval:

```sh
specbridge spec approve <name> --stage requirements
```

Re-approving a stage whose content changed also invalidates dependent
approvals persistently (they were made against different content) and says
so. Re-approving identical bytes keeps them.

## Revocation

`--revoke` sets the stage back to draft, clears its hash and timestamp, and
invalidates every approval that depended on it. Files are never deleted or
modified; the command reports exactly which approvals were invalidated.

## Existing Kiro projects (unmanaged specs)

Specs created by Kiro have no SpecBridge state. They list, show, and analyze
normally; `spec status` reports `Approval state: unmanaged` with the
suggested first command. The first **successful** approval initializes
sidecar state:

- spec type is inferred from the files (`bugfix.md` → bugfix),
- workflow mode is inferred only when unambiguous: approving the document
  stage first → requirements-first (the default in the absence of contrary
  evidence); approving design first → design-first; approving tasks first is
  refused with guidance,
- `origin` is recorded as `existing-kiro-workspace`.

A blocked approval initializes nothing — failed commands do not write.
