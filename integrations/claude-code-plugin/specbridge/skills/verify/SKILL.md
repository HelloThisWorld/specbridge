---
name: verify
description: Verify SpecBridge spec drift — run the deterministic rule engine over one spec, changed specs, or all specs, and optionally the trusted configured verification commands after user confirmation. Use when the user asks whether code and specs still agree.
---

# SpecBridge verify

Arguments: `[spec-name]` (optional).

1. Decide the scope:
   - spec name given → `scope: "spec"` with that name,
   - otherwise default to `scope: "changed"` (specs affected by the current
     working-tree changes; use `scope: "all"` when the user asks for
     everything).
   Default comparison is the working tree; honor an explicit base/head or
   staged request via the comparison arguments.
2. Call the SpecBridge MCP tool `spec_check_drift`. This runs ONLY the
   deterministic rules — no commands execute and nothing is written.
3. Present the findings grouped by severity, each with its stable rule ID
   (SBV001–SBV025) and remediation. Distinguish clearly:
   - deterministic errors (structural/evidence facts),
   - warnings,
   - heuristic findings (confidence-labelled — call them heuristics).
4. If findings suggest deeper checking (or the user asks), offer to run the
   trusted verification commands configured in `.specbridge/config.json`.
   Name the commands first (they are listed by `spec_context` /
   `workspace_detect` configuration status). Ask explicitly and STOP until
   the user answers.
5. Only after confirmation, call `spec_run_verification` (add
   `persistReport: true` only if the user wants the report kept under
   `.specbridge/reports`). Report each command's actual outcome.
6. Summarize honestly: these checks prove structural and evidence
   consistency between specs, approvals, tasks, and recorded runs. They are
   NOT a semantic proof that the code implements the spec — never claim
   that.
