# CLI and MCP parity

The CLI remains the authoritative runtime; the MCP server is a typed
adapter over the same packages; the plugin skills are thin orchestration
over both. This table maps every capability to its surfaces:

| Capability | CLI | MCP | Plugin skill |
| --- | ---: | ---: | ---: |
| Detect workspace | `doctor`, `mcp doctor` | `workspace_detect` | `doctor` |
| List/read steering | `steering list/show` | `steering_list`, `steering_read` | `doctor`/`status` |
| List/read specs | `spec list/show` | `spec_list`, `spec_read` | `status` |
| Spec status | `spec status` | `spec_status` | `status` |
| Agent context | `spec context` | `spec_context` | (used internally) |
| Create a spec | `spec new` | `spec_create` (preview→apply) | `new` |
| Discover templates | `template list/search/show/validate` | `template_list`, `template_search`, `template_show` | `templates` |
| Apply a template | `template preview/apply`, `spec new --template` | `template_preview` + `template_apply` (hash-bound) | `templates` (after confirmation) |
| Manage template packs | `template install/uninstall/scaffold` | **no** (deliberately CLI-only) | **no** |
| Analyze spec | `spec analyze` | `spec_analyze` | `author`/`status` |
| Apply authored stage | `spec generate/refine` (runner-drafted) | `spec_stage_validate` + `spec_stage_apply` (session-drafted) | `author` |
| **Approve stage** | `spec approve` | **no direct model tool** | `approve` (human-invoked CLI) |
| Execute via nested runner | `spec run`, `run resume` | **no** | **no** |
| Interactive task execution | (lock recovery: `run recover-lock`) | `task_begin` / `task_complete` / `task_abort` | `implement`, `continue` |
| Manual task acceptance | `spec accept-task` | no (human CLI action) | no |
| Verify drift (rules only) | `spec verify --no-run-verification` | `spec_check_drift` | `verify` |
| Verify with trusted commands | `spec verify --run-verification` | `spec_run_verification` | `verify` (after confirmation) |
| Affected specs | `spec affected` | `spec_affected` | `verify` |
| Read runs | `run list/show` | `run_list`, `run_read` + resources | `continue`/`status` |
| Verification rules | `verify rules/explain` | `specbridge://verification/rules` | — |

## Why approval is not an MCP tool

Approval is the one action whose entire meaning is "a human looked at this
exact content and accepted it." Exposing it as a model-callable tool would
let an agent complete the loop it is supposed to be gated by — one
hallucinated "the user said yes" away from self-approving requirements it
also wrote. So:

- the MCP server has no approval tool and no approval prompt;
- the plugin's `approve` skill is `disable-model-invocation: true`, runs
  only when the user types `/specbridge:approve`, and still asks for a
  final confirmation before invoking the bundled CLI;
- everything a model CAN do (author, apply, implement, verify) leaves the
  stage or task in a state that a human approval gate still guards.

The same asymmetry applies to manual task acceptance (`spec accept-task`)
and approval revocation — human CLI actions by design.

## Why the nested runner is CLI-only

The v0.3 runner (`spec run`) launches a separate agent process with its own
permissions and cost. From the CLI that is the point. From inside a Claude
Code session it would mean an agent spawning another agent — cost doubling,
permission confusion, and unclear evidence attribution between the Git
snapshots. The plugin therefore uses the interactive lifecycle exclusively,
and automated tests keep it that way.
