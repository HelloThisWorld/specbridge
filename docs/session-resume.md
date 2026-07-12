# Session resume

Task runs get a generated session id (when the installed Claude Code
version supports `--session-id`), stored in the run record. An interrupted
or unverified run can continue **the same task in the same agent session**:

```sh
specbridge run resume <run-id>
```

## When resume is allowed

All must hold — otherwise resume is refused with the reason and remediation:

- the original run was a task run by a runner that supports resuming
  (Claude Code with `--resume`, or the mock runner)
- a session id was recorded
- the original run ended `blocked`, `failed`, `timed-out`, `cancelled`,
  `implemented-unverified`, or `no-change` — a **verified** task is never
  resumed
- approved spec hashes are still valid and the task still exists, unchanged
- the repository is reconcilable with the run's recorded post-state

## Divergence detection

Before resuming, the current repository is compared with the original run's
`git-after.json` (HEAD plus per-file content hashes). Any difference —
files edited after the run, new changes, a moved HEAD — refuses the resume
and lists the divergence. You resolve it explicitly: restore the post-run
state, or commit/stash your new work, or start a fresh attempt. Changes to
SpecBridge's own `.specbridge/` sidecar (e.g. you fixed `config.json`
between attempts) never count as divergence.

## What the resumed session sees

The resume prompt contains the original task, the previous session's
reported summary and outcome, the **actual** current uncommitted changes,
the failed verification commands from the previous attempt, and unresolved
blocking questions — plus the explicit instruction to continue the same
task from the current state.

## Attribution and evidence

The resumed run keeps the **original run's pre-state as the attribution
baseline**, so work from the interrupted session still counts toward the
same task. Protected-path and HEAD-motion checks use the resume session's
own start, so legitimate between-run edits are not blamed on the agent. The
full post-run pipeline (snapshots, verification, evidence evaluation,
verified-only checkbox update) is identical to a normal run.

## Lineage

Every resume records `parentRunId` → the original run. A fresh attempt on
the same task (when resume is unsupported or refused) also records the
latest previous run as its parent, so a task's full history is
reconstructable from `specbridge run list`.

SpecBridge never silently starts a fresh session while claiming it resumed:
if the installed CLI cannot resume, that is reported honestly and a new
attempt is offered instead.
