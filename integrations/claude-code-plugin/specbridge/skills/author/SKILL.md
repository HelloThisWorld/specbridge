---
name: author
description: Author a SpecBridge spec stage (requirements, bugfix, design, or tasks) — draft the candidate in this session, validate it deterministically, present the diff, and apply only after explicit user confirmation. The stage remains unapproved. Use when the user wants to write or rewrite a spec stage.
---

# SpecBridge author stage

Arguments: `<spec-name> <stage> [instruction…]`.

YOU draft the candidate in this session — never start another agent process
and never call `specbridge spec generate/refine/run`. You never edit `.kiro`
files directly; the MCP tool performs the validated atomic write.

1. Call the SpecBridge MCP tool `spec_status` for the spec. If the requested
   stage is not authorable (approved, or prerequisites unapproved/stale),
   explain the exact gate and stop. An approved stage is only re-authorable
   after a human revokes its approval via the CLI.
2. Gather grounding: `steering_list` + `steering_read` for always-included
   steering, and `spec_read` for the prerequisite documents. Follow the
   user's instruction if one was given.
3. Draft the complete candidate Markdown for the stage. Follow the existing
   document's conventions (Kiro-style headings; EARS acceptance criteria for
   requirements; numbered `- [ ]` checkbox tasks with `_Requirements: x.y_`
   references for tasks).
4. Call `spec_stage_validate` with the candidate.
   - If it reports errors: revise the candidate and validate again (at most a
     few iterations; then show the findings and ask the user how to proceed).
5. Present for review:
   - a short summary of the candidate,
   - your assumptions and open questions,
   - the returned diff,
   - which approvals applying would invalidate (`wouldInvalidateApprovals`).
6. Ask the user explicitly: "Apply this candidate?" and STOP until they
   answer.
7. Only after confirmation, call `spec_stage_apply` with:
   - the exact validated `candidateMarkdown`,
   - `expectedCurrentHash` = the validation's `currentHash`,
   - `expectedCandidateHash` = the validation's `candidateHash`,
   - `acknowledgement: "apply-reviewed-candidate"`.
   If apply reports a hash mismatch (SBMCP017), the document changed
   underneath you — re-validate and re-review; never force.
8. Close by stating clearly: the stage is written but NOT approved. Approval
   is the user's explicit decision: `/specbridge:approve <spec> <stage>`.
