# Dependencies

Every **direct** dependency declared anywhere in the workspace (root
`package.json`, `packages/*/package.json`,
`integrations/*/package.json`). Internal `@specbridge/*` workspace
packages are omitted — they are this repository, not dependencies.

Method: ranges are taken from the manifests on this branch; licenses were
read from each installed package's own `package.json` in the pnpm store of
this workspace (resolved versions live in `pnpm-lock.yaml`). Last
verified: 2026-07-18, for v1.0.0.

## Runtime dependencies

| Name | Range | Declared in | License | Purpose | Shipped in release assets? |
| --- | --- | --- | --- | --- | --- |
| `@actions/core` | `^1.11.1` | `integrations/github-action` | MIT | Action inputs, outputs, annotations, Step Summary | yes — inlined in the committed single-file Action bundle |
| `@modelcontextprotocol/sdk` | `1.29.0` (pinned) | `packages/cli`, `packages/mcp-server` (and a root devDependency for `mcp:inspect`) | MIT | official MCP SDK backing the local stdio server | yes — npm external of `specbridge-cli`; bundled into the plugin and standalone archives |
| `commander` | `^12.1.0` | `packages/cli` | MIT | CLI command tree, option parsing, help text | yes — npm external; bundled in plugin/standalone |
| `execa` | `^9.4.0` | `packages/cli`, `packages/drift`, `packages/runners` | MIT | child processes as argv arrays (git, runner CLIs, trusted verification commands — never a shell) | yes — npm external; bundled in plugin/standalone/Action |
| `picocolors` | `^1.1.0` | `packages/cli`, `packages/reporting` | ISC | terminal color output | yes — npm external; bundled in plugin/standalone/Action |
| `picomatch` | `^4.0.2` | `packages/cli`, `packages/drift` | MIT | glob matching for verification policies and impact areas | yes — npm external; bundled in plugin/standalone/Action |
| `yaml` | `^2.5.0` | `packages/cli`, `packages/compat-kiro` | ISC | steering front-matter parsing | yes — npm external; bundled in plugin/standalone/Action |
| `zod` | `^3.23.8` | `packages/cli` and ten library packages (core, drift, evidence, execution, extension-sdk, extensions, mcp-server, registry, runners, templates) | MIT | runtime schema validation for every persisted and exchanged structure | yes — npm external; bundled in plugin/standalone/Action |

## Development-only dependencies

None of these ship in any release asset; they build, lint, and test the
release assets.

| Name | Range | Declared in | License | Purpose |
| --- | --- | --- | --- | --- |
| `@eslint/js` | `^9.14.0` | root | MIT | ESLint recommended rule sets |
| `@types/node` | `^20.17.0` | root | MIT | Node.js type declarations |
| `@types/picomatch` | `^3.0.0` | `packages/drift` | MIT | picomatch type declarations |
| `eslint` | `^9.14.0` | root | MIT | linting |
| `tsup` | `^8.3.0` | every package | MIT | esbuild-based bundler producing every `dist/` |
| `typescript` | `^5.6.0` | root and every package | Apache-2.0 | compiler and typechecking |
| `typescript-eslint` | `^8.14.0` | root | MIT | TypeScript ESLint integration |
| `vitest` | `^3.0.0` | root | MIT | test runner |

`integrations/claude-code-plugin` is private and declares no third-party
runtime dependencies of its own — it bundles the workspace packages.

## How dependencies reach each release asset

- **npm package `specbridge-cli`** — publishes an explicit `files`
  allowlist (`dist` without sourcemaps, `README.md`, `LICENSE`,
  `NOTICE.md`). Workspace `@specbridge/*` code is bundled into `dist` at
  build time; the third-party runtime dependencies above stay declared as
  regular npm dependencies and install from the registry ("npm
  externals").
- **Claude Code plugin** — `dist/cli.cjs` and `dist/mcp-server.cjs` are
  fully bundled CJS with no `node_modules`. The plugin build generates
  `THIRD_PARTY_LICENSES.txt` for exactly the bundled set — direct **and**
  transitive; the v1.0.0 report covers 112 bundled external packages.
- **GitHub Action** — a committed single-file node20 CJS bundle with
  everything inlined (`noExternal`), including `@actions/core` and its
  transitive chain; CI rebuilds the bundle and diffs it against source.
- **Standalone archives** — package the bundled CLI per platform (plus a
  portable Node distribution) in the release workflow; no dependency is
  installed on the user's machine.

## Audit status

Method: `pnpm audit --prod` at the workspace root (npm advisory database
via the pnpm lockfile). This audits registry advisories only — it is not
a code audit, and dev-only dependencies are excluded by `--prod`.

Outcome on 2026-07-18: **9 vulnerabilities found — severity: 2 low | 4
moderate | 3 high.** All nine advisories are in the single transitive
dependency `undici@5.29.0`, reached only through
`integrations/github-action` → `@actions/core@1.11.1` →
`@actions/http-client@2.2.3` (patched in undici ≥ 6.27.0 per the
advisories). No CLI, MCP server, or plugin runtime dependency tree
includes undici. Because the Action bundle inlines its dependency tree,
the affected undici code is present inside the committed Action bundle;
the advisories concern undici's WebSocket and HTTP client behavior, and
the Action performs no network requests by design (it never fetches).
Tracked as a known finding rather than claimed away — it clears when
`@actions/core`'s chain moves off undici 5.x.
