---
name: implement
description: Implement one approved SpecBridge task in THIS session through the verified interactive lifecycle — task_begin, edit source, task_complete. Completion is decided by actual Git evidence and trusted verification commands, never by claims. Use when the user wants a spec task implemented.
---

# SpecBridge implement task

Arguments: `<spec-name> [task-id]`.

YOU are the implementer, in this session. Never launch a nested agent: no
`claude -p`, no `specbridge spec run`, no runner of any kind. SpecBridge
brackets your work with Git snapshots and updates the task checkbox only for
verified evidence.

1. Call the SpecBridge MCP tool `task_begin` with the spec name (and the
   task id when given; omit it to take the next executable task).
2. If `task_begin` fails, explain the exact gate and stop:
   - SBMCP006/SBMCP005 → stages not approved / approval stale → the user
     runs `/specbridge:approve` (or re-authors first).
   - SBMCP009 → dirty working tree → the user commits/stashes, or explicitly
     asks you to begin with `allowDirty: true`.
   - SBMCP010 → another interactive run is active → `/specbridge:continue
     <run-id>` or `specbridge run recover-lock` after a crash.
3. Read the returned `context`, `boundaries`, and `instructions` — then
   follow the instructions exactly. In particular:
   - implement ONLY the selected task,
   - never edit `.kiro` or `.specbridge`,
   - never change task checkboxes,
   - never commit, push, or reset user changes.
4. Inspect only the repository files relevant to the task. Make the smallest
   safe change that satisfies it, and add or update tests where the task
   requires them. If required information is missing, stop and report the
   blocker instead of guessing (then `task_abort` with that reason).
5. When the source changes are ready, call `task_complete` with:
   - the `runId` from task_begin,
   - an honest `summary`,
   - `reportedChangedFiles` / `reportedTests` for what you believe you did
     (these are recorded as claims — Git evidence decides).
6. Report the ACTUAL results from task_complete:
   - `actualChangedFiles` (not your claims),
   - each verifier outcome,
   - `evidenceStatus` and whether the checkbox was updated.
7. If the outcome is not `verified`, say so plainly — never claim
   completion. Follow `nextRecommendedAction`: typically inspect the failing
   verifier, fix the code, and run a fresh `task_begin`/`task_complete`
   cycle (the previous evidence is preserved).

One task per run. When the user wants the next task too, start a fresh
`task_begin` (use `allowDirty: true` when the previous verified changes are
intentionally uncommitted — SpecBridge never commits for you).
