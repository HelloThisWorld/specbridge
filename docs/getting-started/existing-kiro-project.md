# Using an existing Kiro project

Point SpecBridge at an existing Kiro project and it works. There is no
import step, no export step, and no conversion — that is the product
([migration from Kiro](../migration-from-kiro.md) exists as a page only to
say so).

## What SpecBridge reads

- `.kiro/steering/*.md` — steering files, front matter honored.
- `.kiro/specs/<name>/` — `requirements.md` (or `bugfix.md`), `design.md`,
  `tasks.md`; unknown files are listed and preserved; partial specs are
  reported, never rejected.

Details: [Kiro compatibility](../kiro-compatibility.md).

## What SpecBridge never touches

- It never renames, reformats, or annotates `.kiro` files: no front
  matter, no tool metadata, no re-wrapping. Loading a file and writing it
  back is byte-identical, verifiable any time with
  `specbridge compat check`.
- The one sanctioned edit (flipping a task checkbox after verified
  completion) changes one character on one line; every other byte stays
  identical.
- Kiro can reopen the project tomorrow. Nothing about your files depends
  on SpecBridge.

## Sidecar state is opt-in

Runtime state (approvals, evidence, run records) lives in a separate
`.specbridge/` directory — never inside `.kiro`
([sidecar state](../sidecar-state.md)). You get it in one of two ways:

- implicitly: the first successful `spec approve` initializes state for
  that spec (`origin: existing-kiro-workspace`), or
- explicitly: `specbridge setup`.

## `specbridge setup`

Preview-first workspace initialization. The default run is a dry run and
writes nothing:

```bash
specbridge setup           # preview only — reports what --apply would create
specbridge setup --apply   # create only the missing sidecar directories
```

Guarantees (tested):

- `--apply` creates only missing sidecar directories (`.specbridge/`,
  `.specbridge/state/specs/`) — nothing else is written.
- `.kiro/**` is never touched, and setup never creates `.kiro` either: it
  refuses to run outside an existing Kiro workspace.
- `.specbridge/config.json` is **never created**: safe defaults apply
  without one. Create it later only if you need non-default runners or
  trusted verification commands.
- No `.claude` modification, no provider installation or authentication,
  no network access.

## Next

- [Quickstart](quickstart.md) — the read-only 30-second tour.
- [Approval workflow](../approval-workflow.md) — start recording
  approvals.
- [Migrations & recovery](../migrations/README.md) — if you have sidecar
  state from an older SpecBridge version.
