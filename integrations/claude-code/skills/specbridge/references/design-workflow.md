# Design workflow

Use when creating or revising `design.md` (feature specs) — or the design
half of a bugfix spec.

## Feature design structure

Sections to include when relevant (omit what does not apply; SpecBridge
recognizes these names but requires none of them):

Context · Goals · Non-Goals · Architecture · Components · Interfaces ·
Data Model · Failure Handling · Security · Observability · Testing Strategy ·
Risks · Alternatives

Guidelines:

- Ground every decision in a requirement; reference criterion ids (`1.2`)
  when a design choice exists to satisfy one.
- Mermaid diagrams in fenced ```mermaid blocks are welcome; SpecBridge
  preserves and counts them.
- The Testing Strategy section is what future verification phases check
  against — make it concrete (which layers, which tools).

## Bugfix design structure

```markdown
# Fix Design

## Root Cause
## Proposed Fix
## Alternatives
## Regression Risks
## Validation Strategy
```

The matching `bugfix.md` should already state Current/Expected/Unchanged
Behavior and Reproduction — do not duplicate those here.

## Process

1. Requirements first: confirm requirements.md exists and is approved
   (`specbridge spec show <name>` shows what is present). In a design-first
   workflow the user says so explicitly — note it so sidecar state can record
   it once approvals ship.
2. Draft, present, iterate; get explicit approval before writing tasks.md or
   code.
3. After editing, run `specbridge compat check <name>`.
