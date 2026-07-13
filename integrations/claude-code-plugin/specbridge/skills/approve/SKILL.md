---
name: approve
description: Approve a SpecBridge spec stage (records the approval hash in sidecar state). This is an explicit human decision — only ever runs when the user invokes /specbridge:approve themselves.
disable-model-invocation: true
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/specbridge" spec approve *)
---

# SpecBridge approve stage

Arguments: `<spec-name> <stage>`.

Approval is the human gate of the whole workflow. This skill can only be
invoked explicitly by the user (`disable-model-invocation: true`); never
suggest that you approved something on their behalf, and never invoke the
approval command outside this skill.

1. Parse exactly two arguments: the spec name and the stage
   (`requirements` | `bugfix` | `design` | `tasks`). If either is missing or
   extra arguments were given, ask — never guess.
2. Call the SpecBridge MCP tool `spec_analyze` for that spec and stage, and
   `spec_status` for approval context. Show:
   - error/warning counts (errors block approval),
   - what approving means: the exact current file bytes are hashed and
     recorded; later edits make the approval stale,
   - which downstream stages this approval unblocks.
3. Ask for final explicit confirmation: "Approve <stage> of <spec> as it is
   on disk right now?" and STOP until the user answers.
4. Only after confirmation, run the bundled CLI approval command exactly:

   ```
   "${CLAUDE_PLUGIN_ROOT}/bin/specbridge" spec approve <spec-name> --stage <stage>
   ```

   Substitute only the two parsed arguments. Never append other flags, never
   run any other command from this skill, and never use a globally installed
   specbridge if the bundled one exists.
5. Show the command's result, then the updated `spec_status`. If the CLI
   refused (analysis errors, unmet prerequisites), relay its remediation —
   do not work around it.

To revoke an approval the user runs the same CLI with `--revoke`; that is
also strictly their decision.
