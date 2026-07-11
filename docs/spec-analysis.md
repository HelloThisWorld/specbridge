# Deterministic spec analysis (`spec analyze`)

`specbridge spec analyze <name>` inspects a spec for structural and
consistency problems. The analyzer is deterministic and fully offline: the
same bytes always produce the same findings. No model is involved and none
is required.

```sh
specbridge spec analyze notification-preferences               # all stages
specbridge spec analyze notification-preferences --stage requirements
specbridge spec analyze login-timeout-fix --stage bugfix --json
specbridge spec analyze notification-preferences --strict
```

## Levels and exit codes

| Level | Meaning |
| --- | --- |
| `error` | Blocks approval of that stage |
| `warning` | Reported; never blocks (unless `--strict`) |
| `info` | Context only |

Exit codes: `0` no errors · `1` errors found (with `--strict`, warnings too)
· `2` invalid command, configuration, or runtime failure.

## Stage awareness

When sidecar state exists, strictness follows the workflow:

- **Active stages** (draft or approved): placeholders are errors, a missing
  file is an error.
- **Blocked stages** (waiting on an unapproved prerequisite): placeholders
  are warnings and a missing file is informational — a generated "pending"
  stub is expected there.

Unmanaged specs (no sidecar state) are analyzed at full strictness, but
nothing is assumed about approvals.

## What the analyzers detect

**Requirements** — missing/empty file, missing title or introduction, no
recognized requirements, requirements without acceptance criteria, duplicate
requirement or criterion identifiers, unresolved placeholders, malformed
EARS patterns, criteria without a testable form, vague wording (`support`,
`handle`, `work correctly`, `as appropriate`, …), no error/exceptional
behavior anywhere, missing Out of Scope section, missing non-functional
requirements. Heading matching is tolerant — `Overview` counts as an
introduction, `Non-Goals` counts as out-of-scope — and hand-written
documents are not rejected for differing from generated templates.

**Bugfix** — missing Current/Expected/Unchanged Behavior, missing
reproduction, evidence, or regression-risk discussion, current and expected
behavior that are word-for-word identical, placeholder-only sections.

**Design** — missing overview, architecture/approach, components,
interfaces, failure handling, security considerations, testing strategy, or
risks/trade-offs (all warnings — trivial specs are not forced to have every
section), unresolved placeholders, and real design content written while the
prerequisite stage is still unapproved. Bugfix specs are checked against fix
-design sections (root cause, proposed fix, regression protection,
validation) instead.

**Tasks** — missing/empty file, no recognizable checkbox tasks, malformed
checkboxes, duplicate task numbers, tasks led by vague verbs, no
implementation/test/validation task, references to requirement ids that do
not exist, tasks already checked off before the plan was approved, and
parents marked complete while required children are open. The analyzer
never modifies checkboxes.

## EARS support

The analyzer recognizes EARS-style acceptance criteria:

```
WHEN <condition or event>, THE SYSTEM SHALL <behavior>.
IF <condition>, THEN THE SYSTEM SHALL <behavior>.
WHILE <state>, THE SYSTEM SHALL <behavior>.
WHERE <feature>, THE SYSTEM SHALL <behavior>.
THE SYSTEM SHALL <behavior>.
```

EARS is encouraged, not required. A plain criterion is fine when it contains
a testable modal (`shall`/`must`/`should`/`will`); only a criterion that
*starts* an EARS pattern without finishing it (`WHEN the user logs in.`) is
flagged as malformed, and a criterion with no testable form at all gets a
warning.

## Placeholder detection

Four precise families are recognized (outside code fences):

1. angle-bracket tokens: `<role>`, `<expected behavior>` (HTML tag names are
   excluded),
2. `TBD` / `TODO`,
3. instruction lines ending in "here": `Add edge cases here.`,
   `Describe the correct behavior here.`,
4. the exact pending-stage lines from generated templates.

A document whose entire body is placeholders is reported as
placeholder-only. Detection is deliberately conservative — a false positive
would block approval of a legitimate document.
