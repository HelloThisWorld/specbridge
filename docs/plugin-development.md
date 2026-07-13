# Plugin development

## Build

```bash
pnpm build:plugin
```

runs the workspace build, bundles `dist/cli.cjs` (from `packages/cli`) and
`dist/mcp-server.cjs` (from `packages/mcp-server`) with tsup/esbuild
(`noExternal: everything`, CJS, node20, no source maps), then generates
`THIRD_PARTY_LICENSES.txt`, the `checksums.json` manifest, and the release
ZIP (`scripts/plugin-artifacts.mjs`). The bundle is reproducible for
identical inputs and toolchain: no timestamps, no absolute paths, sorted
license report, sorted checksums, fixed-timestamp store-method ZIP.

The bundles are **committed** (like the GitHub Action bundle) so installing
the plugin straight from the GitHub marketplace source works without a build
step. Rebuild and commit them together with source changes.

## Validate

```bash
pnpm validate:plugin        # deterministic, offline, no Claude Code needed
pnpm verify:plugin-bundle   # mandatory isolated-copy verification
```

`validate:plugin` checks manifests, skill frontmatter and safety rules,
wrappers, version consistency, forbidden permission strings, absolute build
paths, workspace-import leftovers, and the ZIP contents.
`verify:plugin-bundle` copies the built plugin to an isolated temp directory
(path containing a space), creates a fixture Kiro project outside the
monorepo, runs the bundled CLI and wrapper, performs a real MCP stdio
handshake, lists tools, invokes `workspace_detect`, and confirms no
monorepo path is referenced.

When Claude Code is installed you can additionally run:

```bash
claude plugin validate ./integrations/claude-code-plugin/specbridge
```

— optional; CI never requires Claude Code.

## Iterate on skills

```bash
claude --plugin-dir ./integrations/claude-code-plugin/specbridge
```

Skills are plain Markdown — edits apply on the next session (or
`/reload-plugins`). Keep skills thin: inspection and lifecycle through the
MCP tools, human-only actions through the bundled CLI, no duplicated core
logic, no direct `.kiro`/`.specbridge` edits, and no nested agent
invocation. `pnpm validate:plugin` and `tests/plugin/plugin.test.ts` enforce
the safety rules; run both before committing skill changes.

## Iterate on the MCP server

The server lives in `packages/mcp-server` and is tested in-memory (no
process) via `tests/mcp/*.test.ts`:

```bash
pnpm vitest run tests/mcp
```

Process-level stdio behavior is covered by
`tests/mcp/mcp-stdio-process.test.ts` against the built
`packages/mcp-server/dist/standalone.js`, and interactively via
`pnpm mcp:inspect` (official MCP Inspector, stdio).

## Testing matrix

| Layer | Command |
| --- | --- |
| Everything | `pnpm test` |
| MCP suites only | `pnpm vitest run tests/mcp` |
| Plugin structure + bundle | `pnpm vitest run tests/plugin` |
| Deterministic plugin validation | `pnpm validate:plugin` |
| Isolated bundle verification | `pnpm verify:plugin-bundle` |

CI needs no Claude Code, no network, no model, no API key, and no global
SpecBridge install.
