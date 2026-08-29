# SpecBridge Codex plugin

Use Codex as a first-class conversation frontend for SpecBridge. The plugin
ships the same local MCP control plane and CLI runtime as the Claude Code
plugin, plus the complete SpecBridge skill set adapted to Codex's native
`SKILL.md` and plugin conventions.

This is a frontend integration, not the `codex-cli` execution runner:

```text
Codex conversation → SpecBridge skills/MCP → SpecBridge control plane
SpecBridge scheduler → codex-cli / claude-code / other configured runners
```

Installing this plugin never enables `codex-default`, changes runner routing,
selects a model, or changes Codex sandbox settings.

## Contents

| Path | Purpose |
| --- | --- |
| `.codex-plugin/plugin.json` | Native Codex plugin manifest |
| `.mcp.json` | Registers the bundled SpecBridge MCP server |
| `skills/` | All public SpecBridge frontend workflows |
| `dist/mcp-launcher.cjs` | Cross-platform project-root launcher |
| `dist/mcp-server.cjs` | Self-contained shared MCP server |
| `dist/cli.cjs` | Self-contained SpecBridge CLI |
| `bin/specbridge`, `bin/specbridge.cmd` | POSIX and Windows CLI wrappers |
| `dist/checksums.json` | SHA-256 manifest for the runtime artifacts |

Node.js 20 or newer must be available on `PATH`.

## Local installation

From the SpecBridge repository root:

```text
codex plugin marketplace add ./integrations/codex-plugin
codex plugin list --marketplace specbridge-local --available --json
codex plugin add specbridge@specbridge-local
```

The current Codex CLI uses install/remove rather than a separate
enable/disable command. To remove the integration:

```text
codex plugin remove specbridge@specbridge-local
codex plugin marketplace remove specbridge-local
```

See `docs/codex-plugin.md` in the repository for the full workflow,
troubleshooting, project-root rules, Windows notes, and smoke scenarios.

## Authority and security

- MCP is the primary structured control surface; shell parsing is not.
- The MCP catalog has no final-approval tool.
- Codex never runs `specbridge spec approve …`; the human runs that command
  in their terminal after reviewing the intake summary.
- Git evidence and trusted verification decide completion, never runner or
  model claims.
- The plugin reads no Codex credentials and changes no Codex sandbox policy.

MIT — see `LICENSE` and `NOTICE.md`.
