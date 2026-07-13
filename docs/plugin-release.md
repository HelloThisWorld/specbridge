# Plugin release

## Artifacts

`pnpm build:plugin` produces, deterministically:

| Artifact | Location |
| --- | --- |
| Bundled CLI | `integrations/claude-code-plugin/specbridge/dist/cli.cjs` |
| Bundled MCP server | `integrations/claude-code-plugin/specbridge/dist/mcp-server.cjs` |
| License report | `integrations/claude-code-plugin/specbridge/dist/THIRD_PARTY_LICENSES.txt` |
| Checksum manifest | `integrations/claude-code-plugin/specbridge/dist/checksums.json` |
| Release ZIP | `dist/specbridge-claude-plugin-0.5.0.zip` |

The ZIP's archive root **is** the plugin root (no nested build directory)
and contains exactly: `.claude-plugin/plugin.json`, `.mcp.json`, `skills/`,
`bin/`, `dist/`, `README.md`, `LICENSE`, `NOTICE.md`. It excludes source
maps, test fixtures, `node_modules`, `.git`, `.kiro`, `.specbridge`,
secrets, and logs. Store-method entries with fixed timestamps make the
archive byte-reproducible for identical inputs.

## Release checklist

1. `pnpm install --frozen-lockfile`
2. `pnpm lint && pnpm typecheck && pnpm test`
3. `pnpm build:plugin`
4. `pnpm validate:plugin`
5. `pnpm verify:plugin-bundle`
6. Commit the rebuilt `integrations/claude-code-plugin/specbridge/dist/`
   together with the source changes (the committed bundle is what GitHub
   marketplace installs use).
7. Optionally exercise the plugin manually:
   `claude --plugin-dir ./integrations/claude-code-plugin/specbridge`
   and run `/specbridge:doctor`.
8. Attach `dist/specbridge-claude-plugin-<version>.zip` to the GitHub
   release.

Version consistency (root, workspace packages, plugin manifest, marketplace
entry, MCP server identity, checksum manifest, bundled `--version` output)
is enforced by `pnpm validate:plugin` — a stale bundle fails validation.

## Non-goals

Packages are not published to npm by this process, and the plugin is not
submitted to any external marketplace. Both remain deliberate, separate
decisions.
