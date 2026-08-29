---
name: orchestrate
description: "Inspect and gate SpecBridge's long-running, local-first job orchestrator — list jobs, explain a job's runtime graph and escalations, surface plan reviews and clarification questions, relay the user's decisions, and hand off to the standalone `specbridge orchestrate run` process. Use when the user asks about an orchestration job, wants autonomous multi-task execution of an approved spec, or needs to unblock a waiting job."
---


# SpecBridge orchestrate (long-running jobs)

Arguments: `[job-id | spec-name]`, plus whatever the user asked for.

## The one rule of this skill

**Long-running jobs are driven by the standalone orchestrator process
(`specbridge orchestrate run <spec>`), never by this session.** That process
schedules bounded workers: a managed local llama.cpp model for cheap
reasoning (classify / plan / critique / diagnose / replan) and the explicitly configured execution runner (Claude Code, codex-cli, or
another compatible runner) — a SEPARATE, ephemeral worker invocation — for
implementation and complex reasoning.

You, the interactive session, are a THIRD thing: the user's window into the
job. You inspect, explain, and relay human decisions. You never:

- never launch `specbridge orchestrate run` yourself (it is a long-running
  foreground process the user owns; print the command for them),
- never launch a nested agent: no `codex exec`, no `claude -p`, no `specbridge spec run`, no
  runner of any kind,
- never implement task content while a job is active (two writers, one
  repository lock, no attribution),
- never approve anything on the user's behalf.

This boundary exists because evidence attribution assumes ONE writer per
dispatch. The standalone orchestrator invoking its explicitly configured runner is the
designed path; this Codex frontend session recursively spawning another coding
agent is the forbidden one.

## Inspect

- `job_list` — every job with status, budget consumption, open questions.
- `job_read` — one job in depth: runtime graph nodes (task, status,
  complexity class, plan revision, attempts, repairs, replans), the latest
  diagnosis, escalations, the blocker, and the exact next action.

Explain what you find in plain terms. The persisted state answers every
"why": why a node was selected (graph order + dependencies), why the local
model or configured runner was used (recorded escalations with reasons), why it
repaired rather than replanned (recorded diagnosis + policy), which budget
was consumed (counters vs budgets).

Research is a sparse escalation inside that runtime, not a default failure
handler. An `investigation` WorkUnit may use an exact prior ResearchRecord or
a bounded DeerFlow call only for an explicit external gap, a durable repeated
UNKNOWN after materially different strategies, contradictory external-system
behavior, or unknown platform behavior not answered by the repository.
Authentication, Docker/tool availability, quota, permissions, compilation,
ordinary tests, product ambiguity, and insufficient selected repository
context keep their existing recovery paths. Report ResearchRecords as
`EVIDENCE_ONLY`: they may inform a replan, never prove objective completion.

For MISSION-DRIVEN specs, each job node is an approved Objective executed
by the objective runtime. Go deeper with `objective_read` (the dynamic work
graph: units, statuses, conflicts, worker identities), `workunit_read` (one
unit's context-projection identity, candidate artifact, evaluations), and
`evaluation_read` — or the read-only CLI equivalents
`specbridge orchestrate objective <jobId> <nodeId>` and
`… workunit <jobId> <nodeId> <workUnitId>`. When a job stops on a contract
conflict or a contract change request, show the recorded claims verbatim
and point the user at the human decision paths:
`specbridge mission ccr <missionId> <ccrId> --approve|--reject` and
`specbridge orchestrate answer <jobId> <questionId> <answer…>`. You decide
neither.

## Human gates

When a job stops with `NEEDS_CLARIFICATION` or a pending plan review, the
user decides — you relay:

- Show open questions from `job_read` verbatim, with why each matters.
- Show a pending plan with `specbridge orchestrate node-plan <jobId>
  <nodeId>` (print the command or run it read-only).
- Record THEIR decision: `specbridge orchestrate answer <jobId> <questionId>
  <answer…>` or `specbridge orchestrate review-plan <jobId> <nodeId>
  --approve|--reject`. Present the exact command; run it only when the user
  has stated the decision in this conversation, and pass their words, not
  yours.

Then tell them to resume: `specbridge orchestrate run <spec> --resume
<jobId>`.

## Starting a job

When the user wants autonomous execution of an approved spec:

1. Check readiness: `spec_status` (stages approved?), `runner_doctor`
   (the explicitly configured execution runner available?), and `specbridge local-model doctor` (local
   reasoning configured? optional — without it, reasoning escalates to
   the configured subscription runner and may cost more).
2. Print the command for the user to run in their terminal:

   ```
   specbridge orchestrate run <spec-name>
   ```

   It is a foreground persistent process: Ctrl+C checkpoints and stops
   safely; the same command with `--resume <jobId>` continues the SAME job
   after any interruption.
3. Offer `--dry-run` first if they want to see the worker roster, routing
   policy, and budgets without creating anything.

## Cancelling

`job_cancel` (MCP) or `specbridge orchestrate cancel-job <jobId>` — final,
idempotent, never auto-restarted, all evidence preserved. Confirm the user
actually wants cancellation rather than an answer to the blocking question.

## Related skills

- `$specbridge:develop` — governed implementation by THIS session, one task
  at a time, with you as the worker. Use it for interactive work.
- `$specbridge:implement` — the low-level direct lifecycle.
- `$specbridge:status` — spec/approval state.

Never run `$specbridge:develop` against a spec while a job for that spec is
active: one writer at a time.
