---
name: continue
description: Continue an interrupted SpecBridge interactive run — inspect it, reconcile the repository state, and finish it with task_complete or close it with task_abort. Use when a run was left AWAITING_AGENT_CHANGES (interruption, crash, or handoff).
---

# SpecBridge continue run

Arguments: `<run-id>`.

Honesty first: this continues the EXISTING run. Never silently start a new
run and present it as a resumption.

1. Call the SpecBridge MCP tool `run_read` with the run id (find candidates
   with `run_list` filtered to `AWAITING_AGENT_CHANGES` if the user did not
   provide one).
2. Confirm it is an interactive-execution run that is still
   `AWAITING_AGENT_CHANGES`.
   - Already COMPLETED or ABORTED → report its recorded outcome; nothing to
     continue.
   - The lock was lost or belongs to another run (task_complete would report
     SBMCP012) → explain that this run can no longer be completed safely;
     offer `task_abort` (changes are preserved) and, for crashed processes,
     `specbridge run recover-lock`.
3. Reconcile the repository: compare the run's Git-before summary with the
   current working tree (`workspace_detect`, `git status` via the run detail)
   and read the run's task from `task_list`. Tell the user what work appears
   done and what remains.
4. Continue the unresolved work in THIS session, following the same rules as
   `/specbridge:implement` (only the selected task; no `.kiro`/`.specbridge`
   edits; no checkbox edits; no commits).
5. Finish honestly:
   - work is ready → `task_complete` with the ORIGINAL run id and an honest
     summary;
   - the task cannot continue → `task_abort` with the reason.
6. Only if continuation is impossible (finalized run, lost lock) AND the
   user explicitly agrees, start a fresh run with `task_begin` — and say
   clearly that it is a new attempt, not a resumption.
