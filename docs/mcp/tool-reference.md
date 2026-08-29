# MCP tool reference

<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: pnpm generate:mcp-docs (CI checks drift via pnpm check:mcp-docs). -->

Generated from the authoritative registries of the `specbridge` MCP server
(version 1.1.0). Tool names, resource URI templates, and prompt
names are stable contracts — see docs/stability/public-contracts.md.

## Tools (77)

| Tool | Access | Summary |
| --- | --- | --- |
| `contract_change_request` | write | Raise a contract change request (human decides it) |
| `contract_list` | read-only | Product contract registry and constitution |
| `contract_read` | read-only | One product contract in depth (any revision) |
| `evaluation_read` | read-only | Evaluation records of one objective or work unit |
| `extension_doctor` | read-only | Extension health check (bounded no-op handshake) |
| `extension_list` | read-only | List installed extensions with status |
| `extension_search` | read-only | Offline extension search (installed + cached registries) |
| `extension_show` | read-only | One extension in depth (permissions, hash, grant) |
| `job_cancel` | write | Cancel a job (final, idempotent, evidence preserved) |
| `job_list` | read-only | List long-running orchestration jobs |
| `job_read` | read-only | One job in depth: graph, attempts, questions, checkpoint |
| `mission_answer` | write | Record the user’s answer to one discovery question |
| `mission_assess` | write | Record a governed structured discovery assessment |
| `mission_begin` | write | Begin Mission Discovery from a product direction |
| `mission_questions` | read-only | Open discovery questions with materiality |
| `mission_read` | read-only | One mission in depth (facts, decisions, coverage, artifacts) |
| `mission_record_turn` | write | Persist one user-visible discovery turn (provenance root) |
| `mission_status` | read-only | List missions with lifecycle status and readiness |
| `mission_synthesize` | write | Compile contracts into Kiro spec candidates (approval stays human) |
| `objective_read` | read-only | One objective’s work graph, conflicts, and workers |
| `orchestration_assess_intent` | write | Validate a structured intent assessment |
| `orchestration_begin` | write | Begin a governed orchestration run |
| `orchestration_checkpoint` | write | Write a compact structured checkpoint |
| `orchestration_clarify` | write | Record a bounded round of targeted questions |
| `orchestration_finalize` | write | Close a run (completion needs verified evidence) |
| `orchestration_record_action` | write | Record one bounded iteration; get the next directive |
| `orchestration_resolve_clarification` | write | Record structured clarification decisions |
| `orchestration_review_plan` | write | Record the user plan-review decision (hash-bound) |
| `orchestration_status` | read-only | Governed orchestration state, freshness, and next safe action |
| `orchestration_submit_plan` | write | Validate and store a context-bound execution plan |
| `prepare_intake_decision` | write | Prepare evidence and options for one human intake decision |
| `registry_list` | read-only | List configured extension registries |
| `registry_search` | read-only | Offline registry index search |
| `registry_show` | read-only | Registry metadata for one extension (no download) |
| `repository_inspect` | read-only | Bounded repository sections for a deeper implementation question |
| `research_consider` | write | Apply sparse research policy in one lifecycle phase |
| `research_gate` | write | Deterministic research-escalation decision with reasons |
| `research_get` | read-only | Read one durable ResearchRecord |
| `research_list` | read-only | List durable research records and diagnostics |
| `research_provider_status` | read-only | Normalized provider health without an agent run |
| `research_start` | write | Execute or exactly reuse one bounded research request |
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
| `spec_intake_answer` | write | Record the user’s answer to one product question |
| `spec_intake_read` | read-only | One spec intake: questions, refusals, delta authority, approval summary |
| `spec_intake_start` | write | Ingest a product specification and run repository-grounded discovery |
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
| `workspace_bootstrap` | write | Build or revalidate the CurrentSystemSnapshot |
| `workspace_detect` | read-only | Detect the Kiro-compatible workspace |
| `workspace_snapshot` | read-only | Current-system summary with an explicit freshness verdict |
| `workunit_read` | read-only | One work unit: projection identity, candidate, evaluations |

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
