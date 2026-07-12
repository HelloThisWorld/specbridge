# Affected-spec detection

`specbridge spec affected` (and `spec verify --changed`) resolve which specs
a change set touches. The mapping is deterministic and read-only — no
verification rules run, no commands execute.

## Signals

A spec is affected when at least one changed file:

1. lives under `.kiro/specs/<name>/` (spec files),
2. is the spec's sidecar state file
   (`.specbridge/state/specs/<name>.json`),
3. is the spec's verification policy
   (`.specbridge/policies/<name>.json`),
4. matches one of the policy's declared impact areas,
5. appears in accepted task evidence for the spec (`verified` or
   `manually-accepted` records; freshness is judged later by the rules), or
6. is a file `design.md` explicitly references (backtick path or Markdown
   link — see
   [requirement-task-traceability.md](requirement-task-traceability.md)).

Every match records *which* signal produced it:

```text
Affected specs

notification-preferences
  matched:
    src/notifications/preferences.ts
      via impact area src/notifications/**
```

## Unmapped and ambiguous files

- A changed source or test file that no spec claims is **unmapped**. In
  `--changed`/`--all` verification it produces SBV014 (warning by default,
  policy-configurable to error). It is never silently ignored.
  Workflow/VCS infrastructure (`.kiro/**`, `.specbridge/**`, `.git/**`) is
  exempt from the unmapped check — the protected-path and approval rules
  govern those paths instead.
- A file claimed by more than one spec is **ambiguous**: every matching
  spec is verified, and SBV022 reports the overlap with the matching
  patterns per spec.

Ordering is deterministic: specs sort by name, files by path.

## Selection semantics

| Command | Selection |
| --- | --- |
| `spec verify <name>` | exactly that spec |
| `spec verify --changed` | affected specs (signals above) |
| `spec verify --all` | every spec in the workspace |
| `spec affected` | mapping report only |

In `--changed` mode, each spec's report records *why* it was selected
(`matchedBy`).
