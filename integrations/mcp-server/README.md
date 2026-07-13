# SpecBridge MCP server — moved

The MCP server shipped in **v0.5** and lives at
[`packages/mcp-server`](../../packages/mcp-server) as a first-class
workspace package (`@specbridge/mcp-server`), exactly as this placeholder
promised: a thin adapter over the same packages the CLI uses, with no
duplicated logic.

- Run it: `specbridge mcp serve --stdio --project-root .`
- Diagnose it: `specbridge mcp doctor`
- Documentation: [docs/mcp-server.md](../../docs/mcp-server.md),
  [docs/mcp-tools.md](../../docs/mcp-tools.md),
  [docs/mcp-resources.md](../../docs/mcp-resources.md),
  [docs/mcp-prompts.md](../../docs/mcp-prompts.md)
- Claude Code users: the self-contained plugin bundles this server — see
  [docs/claude-code-plugin.md](../../docs/claude-code-plugin.md) and
  [`integrations/claude-code-plugin`](../claude-code-plugin).

This directory remains only as a pointer for old links.
