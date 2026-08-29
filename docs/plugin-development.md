# Plugin development

## Build

```bash
pnpm build:plugin
```

runs the workspace build, bundles `dist/cli.cjs` (from `packages/cli`) and
`dist/mcp-server.cjs` (from `packages/mcp-server`) with tsup/esbuild
(`noExternal: everything`, CJS, node20, no source maps), then generates
`THIRD_PARTY_LICENSES.txt`, the `checksums.json` manifest, and the release
ZIP (`scripts/plugin-artifacts.mjs`). It then derives the full Codex skill
surface from the canonical Claude skill files and assembles the native Codex
plugin with byte-identical CLI/MCP bundles. The bundles are reproducible for
identical inputs and toolchain: no timestamps, no absolute paths, sorted
license report, sorted checksums, fixed-timestamp store-method ZIP.

The bundles are **committed** (like the GitHub Action bundle) so installing
the plugin straight from the GitHub marketplace source works without a build
step. Rebuild and commit them together with source changes.

Do not maintain Codex skill copies by hand. Host-neutral behavior belongs in
`integrations/claude-code-plugin/specbridge/skills`; the deterministic Codex
adapter owns invocation spelling, supported frontmatter, natural-language
triggers, runner-neutral wording, and the stricter guidance-only approval
skill.

## Validate

```bash
pnpm validate:plugin        # deterministic, offline, no Claude Code needed
pnpm verify:plugin-bundle   # mandatory isolated-copy verification
pnpm check:codex-plugin     # generated Codex skill/runtime drift
pnpm validate:codex-plugin  # structure, parity, safety, current CLI when present
pnpm verify:codex-plugin-bundle # installed-shape launcher + MCP verification
```

`validate:plugin` checks manifests, skill frontmatter and safety rules,
wrappers, version consistency, forbidden permission strings, absolute build
paths, workspace-import leftovers, and the ZIP contents.
`verify:plugin-bundle` copies the built plugin to an isolated temp directory
(path containing a space), creates a fixture Kiro project outside the
monorepo, runs the bundled CLI and wrapper, performs a real MCP stdio
handshake, lists tools, invokes `workspace_detect`, and confirms no
monorepo path is referenced.

`validate:codex-plugin` additionally checks the current Codex manifest and
local-marketplace shapes, 16-skill parity, human-only approval, natural-
language routing contracts, runtime byte identity, and checksums. When Codex
is installed it performs a real add/list/install/remove cycle in an isolated
temporary `CODEX_HOME`. `verify:codex-plugin-bundle` runs the copied launcher
from a nested project path containing spaces, verifies root resolution and
clean stdio, and executes a representative guarded MCP state write.

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

For Codex, rebuild the derived skills and reinstall the local plugin:

```bash
pnpm build:codex-plugin
codex plugin marketplace add ./integrations/codex-plugin
codex plugin add specbridge@specbridge-local
```

See [Codex plugin](codex-plugin.md) for current CLI removal commands and
project-root troubleshooting. No hook or `AGENTS.md` injection is part of
the integration.

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
| Codex generation drift | `pnpm check:codex-plugin` |
| Codex structure + current CLI | `pnpm validate:codex-plugin` |
| Codex installed-shape MCP | `pnpm verify:codex-plugin-bundle` |

CI needs no Claude Code or Codex model, no network, no API key, and no global
SpecBridge install. Codex CLI integration is exercised when the executable is
available; all artifact and MCP guarantees remain mandatory without it.
