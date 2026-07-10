# Task execution

Use when implementing tasks from an existing `tasks.md`.

## Loop (one task at a time)

1. `specbridge spec context <name> --target claude-code` — the "Next open
   tasks" section tells you what is actionable. Work strictly one leaf task
   at a time; never batch checkboxes.
2. Implement the task, honoring steering (structure.md tells you where code
   goes) and the design document.
3. Run the relevant tests/build. A task is done only when they pass.
4. Report evidence to the user: changed files, commands run, exit status.
   (Formal evidence records under `.specbridge/evidence/` arrive with the
   task-execution phase; until then, your report and the commit are the
   evidence.)
5. Update the checkbox — surgically:
   - Edit `.kiro/specs/<name>/tasks.md`.
   - Change that task's `[ ]` to `[x]`. One character. Nothing else on any
     line changes; keep line endings exactly as they are.
   - If a parent task's children are now all complete, the parent may be
     completed the same way — as a separate, equally surgical edit.
6. `specbridge compat check <name>` — must PASS. If it fails, restore the
   file from git and redo the edit.

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
- Include testing tasks and rollout/migration tasks where relevant.

## Do not

- Mark a task complete because code "looks done" — evidence first.
- Reformat, renumber, or "clean up" tasks.md while completing a task.
- Invent new checkbox states; `[ ]`, `[x]`, and the in-progress `[-]` are
  what tools understand.
