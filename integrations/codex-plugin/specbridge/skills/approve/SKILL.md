---
name: approve
description: "Approve a SpecBridge spec stage (records the approval hash in sidecar state). This is an explicit human decision. In Codex the skill only presents the terminal command for the user. It never executes approval."
---

# SpecBridge approval guidance

Arguments: `<spec-name> <stage>`.

Approval is a human authority boundary. Codex may inspect and explain the
current state, but it must never execute an approval command, infer approval
from conversation, or claim approval happened. No SpecBridge MCP approval
tool exists.

1. Call `spec_analyze` for the named stage and `spec_status` for the
   approval context. Show blocking errors, warnings, the current hash-bound
   state, and which downstream stage the approval would unblock.
2. If arguments are missing or the stage is not one of `requirements`,
   `bugfix`, `design`, or `tasks`, ask the user; never guess.
3. Present the exact command for the HUMAN to run in their own terminal and
   STOP:

   ```text
   specbridge spec approve <spec-name> --stage <stage>
   ```

4. After the user reports running it, read `spec_status` again and report
   the recorded state. Never treat their intent to approve as evidence that
   the command succeeded.

For a converged Spec Intake, the separate final authorization is also
human-only: `specbridge spec approve <name> --build`. Codex must never run
either approval command, even when this skill was explicitly invoked as
`$specbridge:approve`.
