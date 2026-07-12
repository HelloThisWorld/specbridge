# Requirement–task traceability

SpecBridge extracts explicit traceability relations from Kiro-compatible
Markdown without regenerating a single byte. Every extracted relation
records its source file, line, extraction method, and whether the
extraction is deterministic (explicit syntax) or heuristic (pattern
recognition).

## Recognized requirement identifiers

From `requirements.md` headings and acceptance criteria:

- `### Requirement 1: Title` and `### R1: Title` (tolerant parser)
- `### REQ-001: Title` (supplemental ID headings)
- numbered acceptance criteria become `<requirement>.<n>` (e.g. `1.2`)
- explicit `AC-3:` markers at the start of a criterion line become aliases

Identifiers are canonicalized case-insensitively: an optional `R`, `REQ`,
`AC`, `Requirement`, or `Criterion` prefix (with `-`, `_`, `.`, or space) is
stripped, `-` between numbers reads as `.`, and leading zeros drop — so
`REQ-001` ≡ `R1` ≡ `Requirement 1` ≡ `1`, and `AC1.2` ≡ `1.2`. Free text
like `TBD` is not an identifier.

## Recognized task references

From `tasks.md`, attributed to the owning task with source lines:

| Form | Method | Confidence |
| --- | --- | --- |
| `_Requirements: 1.1, 2.3_` | `underscore-refs` | deterministic |
| `Requirements: R1, R2` | `refs-line` | deterministic |
| `[R1]`, `[REQ-001]` | `bracket-ref` | deterministic |
| `Supports REQ-001`, `Implements 1.2` | `keyword-ref` | heuristic |

No single format is required; all forms coexist. Unknown references fire
SBV009 (keyword-recognized ones warn instead of erroring, because the
recognition itself is heuristic).

## Design path references

From `design.md`: backtick spans that look like repository paths
(`src/notifications/store.ts`) and Markdown links to repository files.
URLs, anchors, code fragments, absolute paths, traversal, and bare
filenames without a directory are ignored. Glob-shaped references
(`src/notifications/**`) are recorded as impact-area hints, not files.
SBV018 checks that explicit non-glob references exist. **No code ownership
is ever inferred from prose.**

## What the rules do with this

- SBV007 — a requirement no task references (directly or via a criterion)
- SBV008 — a leaf task without references while linking is in use
  (documentation/release/cleanup chores excluded, heuristically)
- SBV009 — a reference to a requirement that does not exist
- SBV017 — test-required language (heuristic) without test evidence

The per-spec report also carries the counts:

```json
"traceability": {
  "requirements": 5,
  "requirementsWithTasks": 4,
  "tasks": 9,
  "tasksWithRequirements": 7
}
```

## Honest limits

Traceability here means *explicit links*. SpecBridge detects missing and
broken links deterministically; it does not — and does not claim to —
verify that linked code satisfies the linked requirement semantically.
