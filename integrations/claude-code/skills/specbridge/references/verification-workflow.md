# Verification workflow

Use after implementing spec work, before telling the user it is done.

## Today (v0.1)

1. **Round-trip safety:** `specbridge compat check <name>` after any `.kiro`
   edit. Must report PASS with every file byte-identical.
2. **Workspace health:** `specbridge doctor` — no errors, "Safe for
   read-only use", round-trip safe.
3. **Spec-code alignment, manually:**
   - Every checkbox you marked `[x]`: name the commit/diff and the passing
     command that justifies it.
   - Every acceptance criterion the task references (`_Requirements: 1.2_`):
     say which test or behavior covers it.
   - Any file you changed outside the areas the design implies: call it out
     to the user explicitly — that is drift until the spec says otherwise.
4. **Honest reporting:** if tests fail or a criterion is uncovered, say so
   plainly. Do not soften failures.

## When the spec and the code disagree

Two valid moves — pick one and tell the user which and why:

- **Repair the code** to match the spec.
- **Propose a spec update** (edit requirements/design with the user's
  approval, keeping ids stable), then re-verify.

Never silently make the spec match whatever the code happens to do.

## Coming in Phase H

`specbridge spec verify <name> --diff origin/main...HEAD` will run these
alignment checks deterministically (evidence, impact areas, requirement
coverage) with exit code 1 on drift. Until it ships, the manual checklist
above is the workflow — do not claim the command ran.
