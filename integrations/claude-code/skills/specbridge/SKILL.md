---
name: specbridge
description: Work with Kiro-style specs (.kiro/steering and .kiro/specs) through the SpecBridge CLI — list specs, generate and approve spec stages, execute approved tasks with evidence-gated completion, inspect and resume runs, and keep every .kiro file round-trip safe. Use when the project contains a .kiro directory or the user mentions specs, steering, requirements.md, design.md, tasks.md, or bugfix.md.
---

# SpecBridge

SpecBridge is a CLI that reads existing `.kiro` directories directly. Your
job when this skill is active: drive the spec workflow **through the CLI**,
keep `.kiro` files byte-safe, and never mark work done without evidence.

Run `specbridge` if it is on PATH; otherwise use
`node <repo>/packages/cli/dist/index.js` from the SpecBridge checkout.

## Non-negotiable rules

1. **The CLI is the authority.** Never bypass SpecBridge approval gates,
   never mark task checkboxes directly, never edit `.specbridge/` state by
   hand. If a command refuses, relay its remediation — do not work around it.
2. **`.kiro` is the source of truth.** Never move, rename, or reformat its
   files. Never add front matter, comments, or metadata to them.
3. **Evidence before completion.** `specbridge spec run` updates a checkbox
   only after deterministic evidence (actual git changes + passing trusted
   verification). Never claim a task is complete because a model said so.
4. **No permission bypasses.** Never suggest or use
   `--dangerously-skip-permissions` or `bypassPermissions` — SpecBridge
   rejects them by design and so should you.
5. **Verify after editing.** After any manual edit to a `.kiro` file, run
   `specbridge compat check <spec>` and confirm PASS.

## Standard workflows

**Status** — `/specbridge status <spec>`:
1. `specbridge doctor` and `specbridge spec list` to see the workspace.
2. `specbridge spec status <name>` for stage approvals and stale detection.

**Author a stage** — `/specbridge generate <spec> <stage>`:
1. `specbridge spec generate <name> --stage <stage>` (add
   `--runner claude-code` or rely on the configured default).
2. Read the result. If analysis errors kept the candidate from applying,
   inspect it under `.specbridge/runs/<run-id>/` and iterate with
   `specbridge spec refine <name> --stage <stage> --instruction "…"`.
3. Show the user the draft; after their review:
   `specbridge spec analyze <name> --stage <stage>` then
   `specbridge spec approve <name> --stage <stage>`. Generated stages are
   never auto-approved — approval is the user's explicit decision.

**Implement a task** — `/specbridge implement <spec> <task>`:
1. `specbridge runner doctor claude-code` (or the chosen runner) first.
2. `specbridge spec run <name> --task <task-id>` (omit `--task` for the next
   open task). One task per run; never parallelize.
3. Read the result block. `VERIFIED` means the checkbox was updated.
   Anything else: inspect with `specbridge run show <run-id>`, fix the cause
   (e.g. failing verification), and either resume or rerun.
4. If the user verified the work manually and asks to accept it:
   `specbridge spec accept-task <name> --task <id> --reason "<their reason>"`.

**Continue an interrupted run** — `/specbridge continue <run-id>`:
1. `specbridge run show <run-id>` — read the outcome, failed verification,
   and warnings before doing anything.
2. `specbridge run resume <run-id>`. If resume is refused (divergence,
   verified task, unsupported), follow the printed remediation instead of
   forcing anything.

## Command reference

Read-only: `doctor`, `steering list/show`, `spec list/show/context/status`,
`spec analyze`, `compat check`, `runner list/doctor/show`, `run list/show`.

Offline authoring (v0.2): `spec new`, `spec approve [--revoke]`.

Runner-assisted (v0.3): `spec generate`, `spec refine`, `spec run`,
`spec accept-task`, `run resume`. All support `--json`; task execution
requires every stage approved and a clean working tree (or an explicit
`--allow-dirty`).

Drift verification (v0.4, read-only, offline): `spec verify <name>` /
`spec verify --changed` / `spec verify --all` with `--diff base...head`,
`--working-tree`, or `--staged`; `spec affected`; `spec policy
init/show/validate`; `verify rules` / `verify explain <id>`. All support
`--json`. Verification never edits .kiro files, checkboxes, approvals, or
evidence — report findings, never "fix" them by editing state.

Still planned (exit 2 honestly): `spec sync`, `spec export` — if the user
asks for them, do the nearest read-only equivalent manually and say that is
what you did. Never claim a planned command ran.

Reference guides in this skill:

- [references/requirements-workflow.md](references/requirements-workflow.md)
- [references/design-workflow.md](references/design-workflow.md)
- [references/task-execution.md](references/task-execution.md)
- [references/verification-workflow.md](references/verification-workflow.md)
