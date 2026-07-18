# Public contract snapshots

Machine-readable snapshots of every stable public contract, generated from
the built packages by `scripts/check-public-contracts.mjs`:

| File | Freezes |
| --- | --- |
| `cli-commands.json` | CLI command tree and long option names |
| `exit-codes.json` | Process exit-code map (0–6) |
| `report-ids.json` | `specbridge.<name>/<rev>` JSON report envelope IDs |
| `schema-versions.json` | Every persisted `schemaVersion` constant |
| `verification-rules.json` | Stable `SBV###` rule IDs |
| `runner-contract.json` | Runner operations, capability keys, categories, support levels, error codes, outcome vocabularies |
| `template-contract.json` | Template manifest name, record types, built-in template IDs |
| `extension-contract.json` | Extension kinds, protocol methods, permission flags, archive suffix |
| `mcp-contract.json` | MCP server name, tool/resource/prompt names |
| `plugin-skills.json` | Claude Code plugin Skill names |
| `github-action.json` | GitHub Action input/output names |

CI runs `pnpm check:public-contracts` and fails when the built surface
drifts from these files.

## Changing a stable contract

1. Confirm the change is allowed for the release type
   (see [docs/stability/versioning-policy.md](../docs/stability/versioning-policy.md)).
2. Run `pnpm build && pnpm generate:public-contracts`.
3. Review the snapshot diff — every changed line is a public-contract change.
4. Add a CHANGELOG entry describing the contract change.

Additions (new commands, new rule IDs, new tools) are allowed in minor
releases. Removals and renames of anything in these files require a
deprecation cycle and, for most surfaces, a major release.
