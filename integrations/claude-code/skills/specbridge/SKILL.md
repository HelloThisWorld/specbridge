---
name: specbridge
description: Work with Kiro-style specs (.kiro/steering and .kiro/specs) through the SpecBridge CLI — list specs, build agent context, execute tasks with evidence, and keep every .kiro file round-trip safe. Use when the project contains a .kiro directory or the user mentions specs, steering, requirements.md, design.md, tasks.md, or bugfix.md.
---

# SpecBridge

SpecBridge is a CLI that reads existing `.kiro` directories directly. Your
job when this skill is active: follow the spec workflow, keep `.kiro` files
byte-safe, and never mark work done without evidence.

Run `specbridge` if it is on PATH; otherwise use
`node <repo>/packages/cli/dist/index.js` from the SpecBridge checkout.

## Non-negotiable rules

1. **`.kiro` is the source of truth.** Never move, rename, or reformat its
   files. Never add front matter, comments, or metadata to them.
2. **Never bypass the spec workflow.** Do not write implementation code for
   spec work before requirements and design content exists and the user has
   accepted it — unless the user explicitly chooses a quick, one-shot spec.
3. **Evidence before completion.** Never mark a task complete because you
   *believe* the work is done. Run the project's tests/build first and cite
   the results.
4. **Surgical edits only.** To complete a task, change that one checkbox
   from `[ ]` to `[x]` in tasks.md and touch nothing else — no renumbering,
   no reflowing, no whitespace cleanup. Preserve the file's existing line
   endings (LF or CRLF).
5. **Verify after editing.** After any edit to a `.kiro` file, run
   `specbridge compat check <spec>` and confirm PASS.

## Standard workflow

1. **Detect:** `specbridge doctor` — confirm the workspace is healthy.
   `specbridge spec list` — see specs, types, and progress.
2. **Load context:** `specbridge spec context <name> --target claude-code`.
   Read the whole document; it contains steering, the spec files, task
   progress, and the next open tasks. Prefer it over ad-hoc file reads.
3. **Work one task at a time:** pick the first open task (the context lists
   them), implement it, run the tests the spec's design/testing sections call
   for.
4. **Record the outcome:** state which files changed and which commands
   passed (this becomes formal evidence tooling in a later SpecBridge phase).
5. **Complete the checkbox** per rule 4, then re-run
   `specbridge compat check <name>`.
6. **Re-generate context** after the spec changes; never work from stale
   context.

Reference guides in this skill:

- [references/requirements-workflow.md](references/requirements-workflow.md)
- [references/design-workflow.md](references/design-workflow.md)
- [references/task-execution.md](references/task-execution.md)
- [references/verification-workflow.md](references/verification-workflow.md)

## Command status (be honest with the user)

Available now: `doctor`, `steering list/show`, `spec list/show/context`,
`compat check`, and — since v0.2 — `spec new`, `spec analyze`,
`spec approve` (with `--revoke`), and `spec status`. Prefer these commands
over doing the equivalent by hand: `spec new` creates Kiro-compatible specs
offline, `spec analyze` gates content deterministically, and `spec approve`
records stage approvals (with byte-exact hashes) in `.specbridge/`.

The commands `spec run/sync/verify/export` are still planned and exit with a
not-implemented message — if the user asks for them, do the equivalent
manually following the reference guides, and say that is what you are doing.
Never claim a planned command ran.
