# Kiro compatibility

SpecBridge reads existing `.kiro` directories directly and guarantees they
stay valid for Kiro. This page defines exactly what "compatible" means.

SpecBridge implements compatibility with **publicly documented file
locations, file names, and observable document semantics only**. It contains
no Kiro proprietary prompts, code, or private APIs, and is not affiliated
with AWS or Kiro (see [NOTICE.md](../NOTICE.md)).

## What SpecBridge reads

```
.kiro/
├── steering/*.md        product.md, tech.md, structure.md + additional files
└── specs/<name>/
    ├── requirements.md  introduction + "Requirement N" blocks + EARS criteria
    ├── design.md        free-form sections (well-known names recognized)
    ├── tasks.md         checkbox task list, nested, numbered, requirement refs
    ├── bugfix.md        Current/Expected/Unchanged Behavior, Reproduction, …
    └── *                unknown files: listed, never parsed or modified
```

### Steering front matter

Steering files may start with YAML front matter controlling inclusion:
`inclusion: always | fileMatch | manual` and `fileMatchPattern`. Files
without front matter are treated as always-included. Invalid YAML degrades to
a warning; the file is still used.

### Requirements

Recognized shape: `### Requirement 1` (any of h2–h4; a digit is required in
the id so titles like "Requirements Document" are never misread), an optional
`**User Story:** …` line, and a numbered list under an `Acceptance Criteria`
heading. Criterion ids are `<requirement>.<number>` (`1.2`), matching the
`_Requirements: 1.2, 2.1_` references Kiro writes into tasks.md. EARS-style
keywords (WHEN/IF … SHALL) are detected per criterion but never required.

### Tasks

Recognized checkbox grammar (any bullet marker, tabs or spaces):

```
- [ ] 1. Open task
  - [x] 1.1 Completed sub-task
    - Detail bullet
    - _Requirements: 1.2, 2.1_
- [ ]* 2. Optional task          (also "(optional)" in the title)
- [-] 3. In-progress marker      (any other single character = unknown state)
```

Flat numbering (`1.1` at the same indent as `1.`), unnumbered tasks, prose
between tasks, HTML comments, and checkboxes inside code fences are all
handled. Malformed boxes (`[ x]`, `[]`) are diagnosed and preserved, never
"fixed".

### Bugfix documents

`bugfix.md` concepts detected by heading (none required): Current Behavior,
Expected Behavior, Unchanged Behavior, Root Cause, Regression Protection /
Risks, Reproduction, Evidence, Constraints, Proposed Fix, Validation
Strategy. British spellings and common variants match.

## Classification rules

- `bugfix.md` present → bugfix spec (even alongside requirements.md, with an
  info diagnostic).
- Otherwise any known file present → feature spec.
- Completeness: `complete` (all of requirements/design/tasks — or
  bugfix/design/tasks), `partial`, or `empty`.
- Workflow (requirements-first / design-first / quick) **cannot be inferred
  from files** — the layout is identical. SpecBridge reads it from sidecar
  state when present and reports `unknown` otherwise. It never guesses.

## The round-trip guarantee

For every file SpecBridge can decode as UTF-8:

1. **No-op:** load → serialize is byte-identical — including CRLF/CR endings,
   UTF-8 BOM, trailing whitespace, and missing final newlines. Verify on your
   own repo: `specbridge compat check`.
2. **Surgical edits:** a checkbox update changes exactly one character on
   exactly one line. Nothing is reflowed, renumbered, or reformatted.
3. **Never:** renaming `.kiro` files, adding front matter or metadata to
   them, or writing generated artifacts into `.kiro`.

Files that are not valid UTF-8 are read best-effort, flagged
(`FILE_NOT_UTF8`), and never written.

## Tolerance summary

| Input | Behavior |
| --- | --- |
| Unknown headings / custom sections | Listed as unknown, preserved |
| Unknown files in spec folders | Listed with kind `other`, never touched |
| Missing design.md / tasks.md | Reported as a partial spec, no error |
| Empty spec folder | Type `unknown`, warning diagnostic |
| Mixed line endings in one file | Warning; preserved exactly |
| Non-English user content | Fully preserved (UTF-8 throughout) |
| Sidecar state disagreeing with files | Files win; warning diagnostic |

## Out of scope (deliberately)

- A replacement spec format for Kiro projects — SpecBridge will never define
  one for `.kiro` workspaces.
- Migrating `.kiro` content to another directory.
- Reproducing Kiro's generation prompts or UI behavior.
