# Verification rules

Stable rule IDs for `specbridge spec verify`. IDs are never silently
renumbered; removing a rule would leave a documented gap. Inspect them at any
time with `specbridge verify rules` and `specbridge verify explain <id>`.

Severities: `error`, `warning`, `info`. Confidence: **deterministic** rules
follow from file bytes, hashes, git output, and exit codes; **heuristic**
rules use pattern recognition and never default to error. Policies may
override severity or disable rules per spec (`rules.SBVxxx` in the policy
file) — except that `.git/**` protection under SBV006 always stays an error.

| ID | Title | Category | Default severity | Confidence |
| --- | --- | --- | --- | --- |
| SBV001 | Required spec file missing | workspace | error | deterministic |
| SBV002 | Spec approval stale | approval | error | deterministic |
| SBV003 | Approval prerequisite invalid | approval | error | deterministic |
| SBV004 | Completed task lacks verified evidence | evidence | warning (error when policy requires evidence) | deterministic |
| SBV005 | Changed file outside declared impact area | impact-area | warning advisory / error strict | deterministic |
| SBV006 | Protected path modified | protected-path | error | deterministic |
| SBV007 | Requirement has no implementation task | requirements | warning (error when policy requires links) | deterministic |
| SBV008 | Task has no requirement reference | tasks | warning | heuristic |
| SBV009 | Task references unknown requirement | tasks | error (warning for keyword-recognized refs) | deterministic |
| SBV010 | Completed parent task has incomplete child task | tasks | error | deterministic |
| SBV011 | Task evidence is stale | evidence | error | deterministic |
| SBV012 | Required verification command failed | verification-command | error | deterministic |
| SBV013 | Required verification command missing | verification-command | error | deterministic |
| SBV014 | Unmapped changed file | mapping | warning (configurable to error) | deterministic |
| SBV015 | Spec changed after implementation evidence | evidence | error | deterministic |
| SBV016 | Task marked complete before task-plan approval | approval | error | deterministic |
| SBV017 | No test evidence for test-required task | evidence | warning (error when policy requires test evidence) | heuristic |
| SBV018 | Design path reference does not exist | design | warning | deterministic |
| SBV019 | Changed file not represented in execution evidence | evidence | warning | deterministic |
| SBV020 | Verification policy invalid | workspace | error | deterministic |
| SBV021 | Diff base unavailable | git | error | deterministic |
| SBV022 | Ambiguous affected-spec mapping | mapping | warning | deterministic |
| SBV023 | Tasks document unexpectedly changed | tasks | error | deterministic |
| SBV024 | Evidence points outside repository | evidence | error | deterministic |
| SBV025 | Verification command timed out | verification-command | error (warning for optional commands) | deterministic |

## Rule notes

- **SBV001** — feature specs need `requirements.md`, `design.md`, `tasks.md`;
  bugfix specs need `bugfix.md`, `design.md`, `tasks.md`. Specs whose type
  cannot be classified are not judged.
- **SBV002** — exact-byte hash comparison for requirements/bugfix/design.
  For the task plan, checkbox-only progress is *not* stale (hash semantics
  v2, see [evidence-freshness.md](evidence-freshness.md)); any other byte
  change is.
- **SBV004** — stale evidence is reported by SBV011/SBV015 instead;
  structurally invalid records count as absent here.
- **SBV005** — evaluated for single-spec verification only. In `--changed` /
  `--all` runs, cross-spec coverage questions are answered by SBV014.
- **SBV006** — the verified specs' own spec files, sidecar state, and policy
  file are exempt (changing them is spec authoring, governed by the approval
  rules) and reported as info; checkbox-only `tasks.md` progress is always
  expected. Everything else protected errors. Policies may downgrade
  non-`.git` findings; `.git/**` stays an error unconditionally.
- **SBV008** — only fires when the tasks document uses requirement linking
  at all; clearly non-requirement chores (documentation, release, cleanup)
  are excluded. Heuristic by nature.
- **SBV009** — references recognized deterministically (underscore form,
  `Requirements:` lines, `[R1]` brackets) error; keyword-phrase references
  (`Supports REQ-001`) are heuristic and warn.
- **SBV011 vs SBV015** — SBV011 fires when the *evidence* no longer matches
  (task identity changed, commit lineage diverged, a referenced stage is no
  longer approved). SBV015 fires when the *spec* moved after the evidence
  (approved requirements/design/task-plan content changed or was re-approved
  later).
- **SBV016** — managed specs only; existing Kiro projects without SpecBridge
  approvals are not judged.
- **SBV017** — test-required detection (task text or referenced requirement
  mentioning tests) is heuristic; the rule checks valid evidence for a
  passing test-ish command or changed test files.
- **SBV021** — carries the `actions/checkout fetch-depth: 0` guidance when
  the clone is shallow. SpecBridge never fetches by itself.
- **SBV023** — compares the checkbox-normalized task plan at the comparison
  base against the current file; managed specs only.

## Exit codes (`spec verify`)

| Code | Meaning |
| --- | --- |
| 0 | Passed according to `--fail-on` |
| 1 | Diagnostics reached the failure threshold |
| 2 | Invalid input, invalid policy (SBV020), or invalid state |
| 3 | Required git comparison unavailable (SBV021) |
| 4 | Required verification command failed to start |
| 5 | Required verification command timed out or was cancelled |
