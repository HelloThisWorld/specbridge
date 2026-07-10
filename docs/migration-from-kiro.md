# Migration from Kiro

**There is no migration.** That is the product.

## Leaving Kiro (or just adding SpecBridge alongside it)

1. Open a terminal in any project that contains `.kiro/`.
2. Run `specbridge doctor`.

Done. There is no import step, no export step, no conversion, no new spec
format, and no second copy of your specs. SpecBridge reads
`.kiro/steering/*.md` and `.kiro/specs/<name>/*.md` exactly where Kiro left
them.

What doctor tells you:

- which steering files and specs exist, and their state (complete / partial)
- whether every file round-trips byte-identically (`compat check` proves it
  file by file)
- whether anything looks malformed — reported, never auto-"fixed"

## What SpecBridge writes, and where

| Location | Written by SpecBridge? |
| --- | --- |
| `.kiro/**` | Only when *you* run a future state-changing command (e.g. marking a task done), and then only surgical single-line checkbox edits. v0.1 is entirely read-only. |
| `.specbridge/**` | Yes — all runtime state (workflow mode, approvals, evidence, reports). See [sidecar-state.md](sidecar-state.md). |
| Anywhere else | Never. |

SpecBridge never renames `.kiro` files, never adds front matter or hidden
metadata to them, and never reformats a document.

## Returning to Kiro

Because `.kiro` remained the source of truth, returning is the same
non-event:

1. Open the project in Kiro.

Everything Kiro understands is exactly where it expects it, byte-for-byte
(modulo any real work you did in the meantime — completed checkboxes are
completed checkboxes, which Kiro reads natively). The `.specbridge/`
directory is unknown to Kiro and simply ignored; delete it if you want, you
lose only SpecBridge's own bookkeeping.

## Working in both at once

Fully supported — that is just files in a repository. Two things to know:

- Approvals and workflow status recorded by SpecBridge live in sidecar state,
  so Kiro will not see them (and vice versa: Kiro's own session state never
  reaches SpecBridge).
- If both tools edit the same file concurrently, git resolves it like any
  other concurrent edit. SpecBridge's surgical edits keep those diffs
  one-line small.

## FAQ

**Do I need to change my folder structure?** No.

**Do I need an API key?** No. Every v0.1 command is offline. Even later
phases require a model only when *you* configure and invoke a runner.

**What if my specs are partially generated or hand-edited?** Supported and
tested — partial specs, custom headings, unknown files, CRLF, BOM, and
non-English content are all preserved.

**What if SpecBridge misreads a file?** It cannot corrupt it: reads are
tolerant, and any write path first proves the file round-trips
byte-identically. Run `specbridge compat check` any time for the proof.
