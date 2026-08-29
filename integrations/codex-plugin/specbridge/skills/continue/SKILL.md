---
name: continue
description: "Continue an interrupted SpecBridge run — an interactive task run or a governed orchestration run. Inspects it, reconciles repository state, detects a stale execution plan, and finishes it honestly. Use when work was left unfinished (interruption, crash, or handoff). Natural-language triggers include \"继续刚才那个被中断的任务\" and \"繼續剛才被中斷的工作\"."
---


# SpecBridge continue run

Arguments: `<run-id>` or `<orchestration-id>`.

Honesty first: this continues the EXISTING run. Never silently start a new
run and present it as a resumption.

## Governed orchestration runs

If the id is an orchestration run (or the user is unsure), call
`orchestration_status` with it — or with no id to list recent runs.

That single call performs the whole reconciliation, without changing
anything: current phase, the active plan revision and whether it is still
fresh, open clarifications, budget usage, the state of any interactive
execution run it owns, and the exact next safe action.

Then act on what it reports:

- **finalized** (`COMPLETED`, `ABORTED`, `CANCELLED`, `REJECTED`) → report the
  recorded outcome. There is nothing to continue; say so rather than starting
  fresh work under the old id.
- **plan stale** → do not implement against it. Explain which binding changed
  (task, approved stage, Git baseline, or policy) and submit a replacement
  plan with `orchestration_submit_plan`; review re-opens if the change is
  material.
- **open questions** → ask the user and record the answers with
  `orchestration_resolve_clarification`.
- **awaiting plan review** → present the plan and record the user's decision.
- **blocked / budget exhausted** → report the blocker and its remediation. Do
  not retry past a budget; the user decides whether to raise it.
- **executing or repairing** → continue the loop as
  `$specbridge:develop` describes, following the directive from
  `orchestration_record_action`.

You remember nothing from the earlier session. Trust the recorded state and
the checkpoint; never narrate what a previous session was "thinking".

If the timeline contains `runtime_research_eligible`, `research_used`, or
`research_degraded`, explain the recorded phase, reason, ResearchRecord id,
new-vs-reused status, and fallback. A runtime investigation is a zero-diff
evidence report for an evaluator/aggregator/replanner; it is not product
completion and cannot resolve a product-authority ambiguity. DeerFlow outage
alone is not a reason to block when the recorded strong-reasoning fallback
remains available.

## Interactive task runs

For a plain interactive run id:

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
   `$specbridge:implement` (only the selected task; no `.kiro`/`.specbridge`
   edits; no checkbox edits; no commits).
5. Finish honestly:
   - work is ready → `task_complete` with the ORIGINAL run id and an honest
     summary;
   - the task cannot continue → `task_abort` with the reason.
6. Only if continuation is impossible (finalized run, lost lock) AND the
   user explicitly agrees, start a fresh run with `task_begin` — and say
   clearly that it is a new attempt, not a resumption.
