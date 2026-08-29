# Plugin release

## Artifacts

`pnpm build:plugin` produces, deterministically:

| Artifact | Location |
| --- | --- |
| Bundled CLI | `integrations/claude-code-plugin/specbridge/dist/cli.cjs` |
| Bundled MCP server | `integrations/claude-code-plugin/specbridge/dist/mcp-server.cjs` |
| License report | `integrations/claude-code-plugin/specbridge/dist/THIRD_PARTY_LICENSES.txt` |
| Checksum manifest | `integrations/claude-code-plugin/specbridge/dist/checksums.json` |
| Claude release ZIP | `dist/specbridge-claude-plugin-<version>.zip` |
| Native Codex plugin | `integrations/codex-plugin/specbridge/` |
| Codex marketplace | `integrations/codex-plugin/.agents/plugins/marketplace.json` |
| Codex launcher/checksums | `integrations/codex-plugin/specbridge/dist/mcp-launcher.cjs` and `checksums.json` |

The ZIP's archive root **is** the plugin root (no nested build directory)
and contains exactly: `.claude-plugin/plugin.json`, `.mcp.json`, `skills/`,
`bin/`, `dist/`, `README.md`, `LICENSE`, `NOTICE.md`. It excludes source
maps, test fixtures, `node_modules`, `.git`, `.kiro`, `.specbridge`,
secrets, and logs. Store-method entries with fixed timestamps make the
archive byte-reproducible for identical inputs.

The Codex artifact is the installable marketplace directory rather than a
second ZIP. Its 16 skills are deterministically derived from the canonical
Claude sources, its CLI and MCP bundles are byte-identical to the Claude
copies, and its launcher/checksum manifest are deterministic. Codex may copy
that directory into its own cache during local marketplace installation.

## Release checklist

1. `pnpm install --frozen-lockfile`
2. `pnpm lint && pnpm typecheck && pnpm test`
3. `pnpm build:plugin`
4. `pnpm validate:plugin`
5. `pnpm verify:plugin-bundle`
6. `pnpm check:codex-plugin && pnpm validate:codex-plugin && pnpm verify:codex-plugin-bundle`
7. Commit the rebuilt `integrations/claude-code-plugin/specbridge/dist/`
   together with the source changes (the committed bundle is what GitHub
   marketplace installs use), plus the generated
   `integrations/codex-plugin/specbridge/` artifact.
8. Optionally exercise the Claude plugin manually:
   `claude --plugin-dir ./integrations/claude-code-plugin/specbridge`
   and run `/specbridge:doctor`.
9. Optionally exercise Codex with an isolated or disposable home:
   `codex plugin marketplace add ./integrations/codex-plugin`, install
   `specbridge@specbridge-local`, then run `$specbridge:doctor` in a fixture
   repository.
10. Attach `dist/specbridge-claude-plugin-<version>.zip` to the GitHub
   release.

Version consistency (root, workspace packages, plugin manifest, marketplace
entry, MCP server identity, checksum manifest, bundled `--version` output)
is enforced by `pnpm validate:plugin`; Codex version, skill, marketplace,
runtime, and checksum consistency is enforced by
`pnpm check:codex-plugin` and `pnpm validate:codex-plugin`. A stale bundle
fails validation.

## Non-goals

Packages are not published to npm by this process, and neither frontend
plugin is submitted to an external marketplace. The Codex integration is a
supported local marketplace source in this repository. Publication remains
a deliberate, separate decision.
