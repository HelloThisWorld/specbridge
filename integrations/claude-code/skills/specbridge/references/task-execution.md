# Task execution

Use when implementing tasks from an existing `tasks.md`.

## Preferred loop (v0.3): let SpecBridge run the task

1. `specbridge spec status <name>` — every stage must be approved and
   unchanged; follow the printed remediation if not.
2. `specbridge runner doctor claude-code` — confirm the runner is ready
   (read-only).
3. `specbridge spec run <name> --task <task-id>` (or no `--task` for the
   next open leaf task). SpecBridge builds the bounded context, invokes the
   runner, snapshots the repository before and after, runs the trusted
   verification commands from `.specbridge/config.json`, and updates the
   checkbox ONLY for verified evidence.
4. Read the result block:
   - `VERIFIED` — done; the checkbox was updated surgically.
   - `IMPLEMENTED BUT UNVERIFIED` — inspect the failed verification with
     `specbridge run show <run-id>`, fix the cause, then
     `specbridge run resume <run-id>` or rerun the task.
   - Any violation (protected paths, moved HEAD) — report it to the user;
     never roll back or work around it yourself.
5. Nothing is committed automatically. Suggest the user review and commit
   the verified changes before the next task.

Never run tasks in parallel, never batch checkboxes, never edit
`.specbridge/` state, and never bypass a refused gate.

## Manual fallback (runner unavailable)

If no runner can execute the task and the user wants you to implement it
directly in the conversation:

1. `specbridge spec context <name> --target claude-code` and work strictly
   one leaf task at a time.
2. Implement the task honoring steering and the design document, then run
   the project's tests/build and report the real results.
3. Ask the user to accept the work explicitly:
   `specbridge spec accept-task <name> --task <id> --reason "<their words>"`
   — this records `manually-accepted` evidence and updates the checkbox
   surgically. Do NOT edit the checkbox yourself when the CLI is available.
4. `specbridge compat check <name>` — must PASS after any `.kiro` edit.

## tasks.md conventions (when writing new tasks)

```markdown
# Implementation Plan

- [ ] 1. Top-level task
  - [ ] 1.1 Sub-task
    - Detail line explaining scope
    - _Requirements: 1.1, 1.2_
- [ ]* 2. Optional task (property tests, benchmarks)
```

- Number tasks; nest sub-tasks by indentation.
- Link every leaf task to the criteria it satisfies with
  `_Requirements: …_` — drift verification builds on these links.
- Only leaf tasks are executable; parents are groupings.
