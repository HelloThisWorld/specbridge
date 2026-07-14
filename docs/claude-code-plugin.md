# Claude Code plugin

A self-contained Claude Code plugin that turns the SpecBridge workflow into
namespaced `/specbridge:*` commands backed by the bundled MCP server and
CLI. After installation the plugin needs nothing outside its own directory:
no global npm install, no workspace resolution, no network for normal
operation — only Node.js 20+ on `PATH`.

## Directory structure

```text
integrations/claude-code-plugin/specbridge/
├── .claude-plugin/
│   └── plugin.json            plugin metadata (ONLY metadata lives here)
├── .mcp.json                  bundled stdio MCP server configuration
├── README.md · LICENSE · NOTICE.md
├── skills/
│   ├── doctor/SKILL.md        /specbridge:doctor
│   ├── status/SKILL.md        /specbridge:status [spec]
│   ├── new/SKILL.md           /specbridge:new <spec> [description]
│   ├── author/SKILL.md        /specbridge:author <spec> <stage> [note]
│   ├── approve/SKILL.md       /specbridge:approve <spec> <stage>   (human-only)
│   ├── implement/SKILL.md     /specbridge:implement <spec> [task]
│   ├── continue/SKILL.md      /specbridge:continue <run-id>
│   └── verify/SKILL.md        /specbridge:verify [spec]
├── bin/
│   ├── specbridge             POSIX wrapper → dist/cli.cjs
│   └── specbridge.cmd         Windows wrapper → dist/cli.cjs
└── dist/
    ├── cli.cjs                self-contained SpecBridge CLI (CJS bundle)
    ├── mcp-server.cjs         self-contained MCP server (CJS bundle)
    ├── THIRD_PARTY_LICENSES.txt
    └── checksums.json         SHA-256 manifest of the bundle
```

`.mcp.json` launches the bundled server for the current project:

```json
{
  "mcpServers": {
    "specbridge": {
      "command": "node",
      "args": [
        "${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.cjs",
        "--stdio",
        "--project-root",
        "${CLAUDE_PROJECT_DIR}"
      ]
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` keeps the configuration cache-safe: the plugin works
from wherever Claude Code copies it, with no absolute build-machine path
anywhere in the artifact.

## Skill design

Skills are **thin orchestration** — they call the MCP tools for inspection
and controlled lifecycle operations and never duplicate core logic:

- `doctor`/`status` are read-only (`workspace_detect`, `spec_list`,
  `spec_status`).
- `new` previews with `spec_create(apply: false)` and creates only after
  explicit confirmation.
- `author` drafts in the current session, validates with
  `spec_stage_validate`, shows the diff, and applies via `spec_stage_apply`
  only after explicit confirmation — the stage remains unapproved.
- `approve` is the human gate: `disable-model-invocation: true` (Claude can
  never trigger it), a narrowly scoped Bash allowance for exactly
  `"${CLAUDE_PLUGIN_ROOT}/bin/specbridge" spec approve …`, and a final
  explicit confirmation before the CLI runs.
- `implement` uses the interactive lifecycle
  (`task_begin` → this session edits → `task_complete`) and reports the
  ACTUAL evidence outcome. It never invokes `specbridge spec run`, `claude
  -p`, or any nested agent — that invariant is enforced by automated scans
  in `pnpm validate:plugin` and the test suite.
- `continue` finishes an interrupted interactive run honestly (never
  presenting a fresh run as a resumption).
- `verify` runs `spec_check_drift` and asks before `spec_run_verification`.
- `runners` (v0.6.1) is read-only runner inspection: it calls
  `runner_list` and `runner_matrix` (and `runner_show`/`runner_doctor`
  for a named profile), explains categories and local-versus-network
  boundaries, and recommends compatible profiles for an operation. It
  never edits configuration, never invokes any provider or nested agent,
  never sends a network request itself, and never starts a login. The
  existing implementation workflow is unchanged: `task_begin` → the
  current Claude Code session edits → `task_complete`.

No skill uses `bypassPermissions`, `dangerously-skip-permissions`,
unrestricted `Bash(*)`, or unrestricted `Write`, and no skill instructs
direct edits to `.kiro` or `.specbridge`.

## Tool scoping

Claude Code prefixes tools from plugin-bundled MCP servers with a
host-generated scope (visible via `/mcp`), which may differ from manually
configured servers. Skills therefore reference tools by their short names
(`task_begin`, `spec_status`, …). Nothing in the server hardcodes a prefix.

## Why no nested Claude invocation

The plugin's implementation workflow must never start a second agent: the
current session already IS the agent, a nested run would double cost and
confuse permissions, and evidence attribution assumes exactly one actor
between the Git snapshots. The v0.3 runner (`specbridge spec run`) remains
fully supported **from the standalone CLI** for users who want detached
execution — it is only the plugin path that forbids it. Automated tests scan
the skills and the interactive execution code for `claude -p`,
`spec run`, runner-registry usage, and process spawning.

See [plugin-installation.md](plugin-installation.md),
[plugin-development.md](plugin-development.md),
[plugin-security.md](plugin-security.md), and
[plugin-release.md](plugin-release.md).
