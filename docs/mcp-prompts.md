# MCP prompts

Reusable workflow prompts for MCP clients that are not Claude Code (Claude
Code users get the plugin's skills instead). Prompts are guidance only:
they order the tool calls, name the explicit human approval boundaries, and
never claim that model output counts as evidence. They contain no
proprietary Kiro prompt material and no permission escalation of any kind.

| Prompt | Arguments | Guides the client model through |
| --- | --- | --- |
| `specbridge-status` | `specName?` | `workspace_detect` + `spec_list`, or `spec_status` — then explain the next valid workflow step. Stale approvals are explained as human re-approval work, never worked around. |
| `specbridge-author-stage` | `specName`, `stage`, `instruction?` | Read status + steering + prerequisites → draft the candidate in-session → `spec_stage_validate` (iterate on errors) → present summary, assumptions, open questions, diff, and approval impact → **explicit user confirmation** → `spec_stage_apply` with the bound hashes → state that the stage remains unapproved. |
| `specbridge-implement-task` | `specName`, `taskId?` | `task_begin` → inspect only relevant source → smallest safe change (+ tests) → `task_complete` with honest claims → report the ACTUAL evidence outcome; `task_abort` on blockers. Explicitly forbids launching another agent process. |
| `specbridge-verify` | `specName?`, `comparison?`, `strict?` | `spec_check_drift` → present findings by severity with rule IDs and remediation, distinguishing deterministic from heuristic → ask before `spec_run_verification` → never claim complete semantic proof. |

Design rules the prompts follow:

- **Clear tool ordering** — each prompt is a numbered sequence of tool
  calls with decision points.
- **Explicit human boundaries** — applying a candidate requires user
  confirmation; approval is always described as a human CLI action
  (`specbridge spec approve`), never as something the model performs.
- **No evidence claims** — reported changes/tests are described as claims;
  verification comes from Git evidence and trusted commands.
- **Honest limits** — the verify prompt requires stating that the checks
  prove structural/evidence consistency, not semantic correctness.

Stage approval is intentionally not reachable from any prompt or tool; see
[cli-mcp-parity.md](cli-mcp-parity.md) for the rationale.
