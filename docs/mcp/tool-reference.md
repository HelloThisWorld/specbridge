# MCP tool reference

<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: pnpm generate:mcp-docs (CI checks drift via pnpm check:mcp-docs). -->

Generated from the authoritative registries of the `specbridge` MCP server
(version 1.0.0). Tool names, resource URI templates, and prompt
names are stable contracts — see docs/stability/public-contracts.md.

## Tools (37)

| Tool | Access | Summary |
| --- | --- | --- |
| `extension_doctor` | read-only | Extension health check (bounded no-op handshake) |
| `extension_list` | read-only | List installed extensions with status |
| `extension_search` | read-only | Offline extension search (installed + cached registries) |
| `extension_show` | read-only | One extension in depth (permissions, hash, grant) |
| `registry_list` | read-only | List configured extension registries |
| `registry_search` | read-only | Offline registry index search |
| `registry_show` | read-only | Registry metadata for one extension (no download) |
| `run_list` | read-only | Bounded run summaries |
| `run_read` | read-only | Safe single-run summary |
| `runner_doctor` | read-only | Runner diagnostics (never a model request) |
| `runner_list` | read-only | Runner profiles with capabilities and availability |
| `runner_matrix` | read-only | Authoritative runner capability matrix |
| `runner_show` | read-only | One runner profile in depth (redacted) |
| `spec_affected` | read-only | Affected-spec resolution for a change set |
| `spec_analyze` | read-only | Deterministic spec analysis |
| `spec_check_drift` | read-only | Deterministic drift rules (no commands) |
| `spec_context` | read-only | Bounded agent-ready context |
| `spec_create` | write | Preview-first offline spec creation |
| `spec_list` | read-only | List specs with status and progress |
| `spec_read` | read-only | Read canonical spec documents |
| `spec_run_verification` | write | Drift rules + trusted configured commands |
| `spec_stage_apply` | write | Apply a reviewed stage candidate atomically |
| `spec_stage_validate` | read-only | Validate a stage candidate (no write) |
| `spec_status` | read-only | Authoritative workflow status for one spec |
| `steering_list` | read-only | List steering documents |
| `steering_read` | read-only | Read one steering document by name |
| `task_abort` | write | Abort an interactive run, preserving changes |
| `task_begin` | write | Begin an interactive task run (lock + snapshot) |
| `task_complete` | write | Finalize an interactive run with evidence |
| `task_list` | read-only | Parsed task hierarchy with evidence summaries |
| `task_next` | read-only | Next executable task or blockers |
| `template_apply` | write | Hash-bound spec creation from a reviewed template |
| `template_list` | read-only | List built-in and project spec templates |
| `template_preview` | read-only | Render a template without writing (candidate hash) |
| `template_search` | read-only | Deterministic local template search |
| `template_show` | read-only | One template in depth (variables, files, README) |
| `workspace_detect` | read-only | Detect the Kiro-compatible workspace |

Write tools mutate only spec documents and SpecBridge sidecar state through
the same guarded code paths as the CLI; there is deliberately no arbitrary
filesystem, shell, or Git tool, and no stage-approval tool.

## Resources (7)

| URI template | Summary |
| --- | --- |
| `specbridge://runs/{runId}` | Safe summary of one recorded run |
| `specbridge://specs/{specName}/{document}` | Canonical spec document (requirements | bugfix | design | tasks) |
| `specbridge://specs/{specName}/context` | Bounded agent-ready context for one spec |
| `specbridge://specs/{specName}/status` | Authoritative workflow status for one spec |
| `specbridge://steering/{name}` | One steering document by name |
| `specbridge://verification/rules` | The stable deterministic verification rule registry |
| `specbridge://workspace` | Workspace detection summary |

## Prompts (4)

| Prompt | Summary |
| --- | --- |
| `specbridge-author-stage` | Draft, validate, review, and apply a stage candidate |
| `specbridge-implement-task` | Implement one task through task_begin → task_complete |
| `specbridge-status` | Inspect workspace or spec status and the next valid step |
| `specbridge-verify` | Run deterministic drift checks and explain the findings |
