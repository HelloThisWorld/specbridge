# Task verification

A task checkbox flips from `[ ]` to `[x]` only when evidence reaches
`verified` or `manually-accepted`. Nothing else — not a confident model
summary, not a claimed test run — updates a checkbox.

## Trusted verification commands

Verification commands come **exclusively** from `.specbridge/config.json`.
They are never derived from spec Markdown, model output, or anything else an
agent could influence — spec files, source files, and model output are
untrusted input by principle.

```json
"verification": {
  "commands": [
    { "name": "test",      "argv": ["pnpm", "test"],      "timeoutMs": 600000, "required": true },
    { "name": "typecheck", "argv": ["pnpm", "typecheck"], "timeoutMs": 600000, "required": true }
  ]
}
```

Commands run sequentially from the repository root as argv arrays (no
shell), each with its own timeout; stdout/stderr and exit codes are recorded
in the run directory. A **required** command failing means the task is not
verified; an **optional** command failing produces a warning.

`--no-verify` skips the commands: a changed task then ends
`implemented-unverified` and the checkbox stays unchanged. With **no**
commands configured, tasks can never auto-verify — configure at least one.

## The verification decision

A task is automatically `verified` only when ALL hold:

1. the runner completed successfully (no timeout, no cancellation, no
   permission failure)
2. actual repository changes exist and every change is attributable to the
   run (hash-exact baseline)
3. the structured runner output validated
4. verification ran and every required command passed
5. approved spec hashes remained valid throughout the run
6. the selected task still exists with its recorded text
7. no protected path changed (`.kiro/**`, `.specbridge` state/config,
   configured `execution.protectedPaths`) and HEAD did not move
8. the tasks document itself was not modified by the runner

A protected-path violation flags the run, prevents verification, preserves
all evidence, and is reported loudly — **SpecBridge never rolls changes
back**; you decide what to do with the working tree.

## The checkbox update

The update uses the v0.1 surgical writer: exactly one character on exactly
one line changes (`[ ]` → `[x]`); indentation, numbering, title, trailing
whitespace, line endings (LF/CRLF), and every other byte stay identical.
Before writing, the recorded line is re-checked — if `tasks.md` changed
since selection, the update fails safely and nothing is written. The exact
before/after line is recorded in `checkbox-update.json`.

Because this sanctioned edit changes the approved file's bytes, SpecBridge
re-records the tasks approval hash afterwards; a checkbox update therefore
never trips the stale-approval detector. Parent tasks are **not**
auto-completed in v0.3.

## Manual acceptance

For work you verified yourself (e.g. manually in a dev environment):

```sh
specbridge spec accept-task <name> --task 2.3 \
  --run <run-id> \
  --reason "Verified manually in the local development environment."
```

- a non-empty `--reason` is required and recorded verbatim
- the actor is recorded as `local-user` with a timestamp and the referenced
  run when given
- the evidence status is `manually-accepted` — reports always show it
  distinctly and never pretend automated verification passed
- the checkbox update is the same surgical edit

There is no `--force-complete` and there never will be.
