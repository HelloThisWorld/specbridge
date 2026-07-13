---
name: status
description: Show SpecBridge spec status — list all specs, or show one spec's workflow state, stage approvals, stale-approval detection, and task progress, with the next valid workflow step. Use when the user asks where a spec stands or what to do next. Read-only.
---

# SpecBridge status

Arguments: `[spec-name]` (optional).

Read-only: never approve, edit, or "fix" anything from this skill.

## No spec name given

1. Call the SpecBridge MCP tool `spec_list`.
2. Present a compact table: name, type/mode, workflow status, approval
   health, task progress.
3. If a spec has `approvalHealth: stale`, flag it and suggest
   `/specbridge:status <that-spec>` for details.

## Spec name given

1. Call the SpecBridge MCP tool `spec_status` with the spec name.
2. Present each stage with its EFFECTIVE state (`approved`, `draft`,
   `blocked`, `modified-after-approval`, `stale-prerequisite`).
3. For stale approvals, explain plainly: the approved file's bytes changed
   after approval, so the recorded approval no longer applies. Re-approval is
   a human action: `/specbridge:approve <spec> <stage>`. Never work around a
   stale approval.
4. Show task progress and, when helpful, `task_next` for the next executable
   task.
5. End with the single next valid step from `suggestedNextActions`, mapped to
   plugin commands:
   - author a draft stage → `/specbridge:author <spec> <stage>`
   - approve a stage → `/specbridge:approve <spec> <stage>` (human decision)
   - implement a task → `/specbridge:implement <spec> [task-id]`
   - all tasks done → `/specbridge:verify <spec>`

Approval state comes only from the tools — never infer approval from a
file's existence or contents.
