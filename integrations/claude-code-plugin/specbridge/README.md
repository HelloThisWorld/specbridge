# SpecBridge Claude Code plugin

Continue existing [Kiro](https://kiro.dev)-style specs (`.kiro/steering`,
`.kiro/specs`) with Claude Code: validated stage authoring, verified
interactive task execution, and deterministic spec drift checks.

SpecBridge is an **independent open-source project** — not affiliated with,
endorsed by, or sponsored by AWS or the Kiro team (see [NOTICE.md](NOTICE.md)).

## What the plugin contains

Everything runs from this directory after installation — no global npm
install, no network access for normal operation:

| Path | Purpose |
| --- | --- |
| `.claude-plugin/plugin.json` | Plugin manifest |
| `.mcp.json` | Launches the bundled stdio MCP server for the current project |
| `dist/mcp-server.cjs` | Self-contained MCP server (tools, resources, prompts) |
| `dist/cli.cjs` | Self-contained SpecBridge CLI |
| `bin/specbridge`, `bin/specbridge.cmd` | CLI wrappers (POSIX and Windows) |
| `skills/` | The `/specbridge:*` commands |
| `dist/THIRD_PARTY_LICENSES.txt` | Licenses of bundled dependencies |
| `dist/checksums.json` | SHA-256 manifest of the bundled files |

Requires Node.js 20+ on `PATH` (the same requirement as Claude Code).

## Commands

```text
/specbridge:doctor                                check the setup (read-only)
/specbridge:status [spec-name]                    list specs / show one spec
/specbridge:new <spec-name> [description]         preview, confirm, create
/specbridge:author <spec-name> <stage> [note]     draft → validate → review → apply
/specbridge:approve <spec-name> <stage>           HUMAN approval (never model-invoked)
/specbridge:implement <spec-name> [task-id]       verified interactive task execution
/specbridge:continue <run-id>                     finish an interrupted run
/specbridge:verify [spec-name]                    deterministic drift checks
```

## How implementation works (no nested agents)

```text
/specbridge:implement
        ↓
task_begin            lock + pre-run Git snapshot + approved context
        ↓
current Claude session edits source files
        ↓
task_complete         post-run snapshot → actual changed files
        ↓
Git evidence + trusted verification commands
        ↓
verified task completion (exactly one checkbox updated)
```

The current session is the implementer. The plugin never launches a nested
Claude process, model claims are recorded as claims only, and the task
checkbox changes only for **verified** evidence.

## Safety model

- `.kiro` stays the content source of truth; the plugin never edits it
  directly (validated atomic writes go through the MCP tools).
- Stage **approval is not an MCP tool**: `/specbridge:approve` is a human
  decision that runs the bundled CLI, and Claude cannot invoke that skill
  proactively.
- The MCP server exposes no arbitrary filesystem, shell, or Git tool. The
  only commands it ever executes are the trusted verification commands from
  the project's own `.specbridge/config.json`.
- No automatic Git commit, push, reset, stash, or rollback — ever.

## Tool naming

The bundled MCP server registers as `specbridge` with short tool names
(`workspace_detect`, `task_begin`, …). Claude Code scopes tools from
plugin-bundled MCP servers with a host-generated prefix (shown in `/mcp`),
which can differ from manually configured servers — the skills therefore
refer to tools by their short names.

## Documentation

Full documentation lives in the SpecBridge repository:
<https://github.com/HelloThisWorld/specbridge> (see `docs/claude-code-plugin.md`,
`docs/plugin-installation.md`, and `docs/plugin-security.md`).

## License

MIT — see [LICENSE](LICENSE).
