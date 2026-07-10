# Claude Code integration

SpecBridge is CLI-first; the Claude Code integration is a thin wrapper that
teaches Claude Code to drive the CLI. The CLI remains the product core, so
everything here also works with any other agent that can run shell commands.

## Using SpecBridge with Claude Code today (v0.1)

1. Build or install specbridge so the `specbridge` command (or
   `node <repo>/packages/cli/dist/index.js`) is runnable in your project.
2. Generate context for the spec you are working on:

   ```sh
   specbridge spec context user-authentication --target claude-code
   ```

3. Paste or pipe that document into Claude Code (or write it to a file with
   `--out .specbridge/reports/context.md` and reference it). It contains
   steering, the spec documents, task progress, the next open tasks, and
   working agreements for editing `.kiro` files safely.
4. After Claude Code edits `.kiro` files, prove nothing broke:

   ```sh
   specbridge compat check user-authentication
   ```

The `--target claude-code` variant adds those two commands to the working
agreements so the agent self-verifies.

## The skill

A Claude Code skill lives at
`integrations/claude-code/skills/specbridge/SKILL.md` with reference
workflows for requirements, design, task execution, and verification.
Install it by copying the `specbridge` skill directory into your project's
`.claude/skills/` directory:

```sh
cp -r integrations/claude-code/skills/specbridge .claude/skills/specbridge
```

The skill instructs Claude Code to:

1. Detect existing `.kiro` specs (`specbridge doctor`, `spec list`).
2. Never bypass the spec workflow; avoid writing code before requirements
   and design exist unless the user explicitly wants a quick spec.
3. Build context with `specbridge spec context` instead of ad-hoc file reads.
4. Execute one task at a time and gather evidence (tests, diffs).
5. Update only the finished task's checkbox (`[ ]` → `[x]`), surgically.
6. Run `specbridge compat check` after touching `.kiro` files.
7. Preserve `.kiro` compatibility absolutely — no reformatting, no metadata.

Commands that are still planned (`spec run`, `spec verify`) are marked as
such in the skill; it never instructs the agent to pretend they exist.

## Planned (later phases)

- `specbridge spec run <name> --runner claude-code` — Phase F/G: SpecBridge
  invokes Claude Code per task, records run metadata and evidence, and only
  then updates the checkbox.
- `specbridge spec verify` in the loop — Phase H: the agent repairs drift or
  explains why the spec should change.
- Slash-command style workflows (`/specbridge list`, `/specbridge run <spec>`)
  following whatever invocation format Claude Code recommends at that time.
