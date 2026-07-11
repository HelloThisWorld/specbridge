# SpecBridge MCP server (planned — not implemented)

An optional MCP (Model Context Protocol) server exposing SpecBridge to
MCP-capable clients. **No code exists yet, deliberately**: per the roadmap,
the MCP server is not built before the CLI, compatibility layer, and drift
verifier are stable (Phase K).

## Design commitments

- The server will be a thin adapter over the same packages the CLI uses
  (`@specbridge/core`, `@specbridge/compat-kiro`, `@specbridge/drift`,
  `@specbridge/runners`). **No logic will be duplicated.**
- Read-only tools stay read-only; state-changing tools follow the same
  evidence and sidecar rules as the CLI.
- No tool will ever write SpecBridge metadata into `.kiro` files.

## Planned tools

| Tool | Maps to |
| --- | --- |
| `detect_workspace` | `core.resolveWorkspace` / doctor summary |
| `list_steering` | `steering list` |
| `read_steering` | `steering show` |
| `list_specs` | `spec list` |
| `read_spec` | `spec show --json` |
| `create_spec` | `spec new` (CLI ✅ since v0.2) |
| `analyze_spec` | `spec analyze` (CLI ✅ since v0.2) |
| `approve_stage` | `spec approve` / `spec status` (CLI ✅ since v0.2) |
| `get_next_tasks` | next-open-tasks from the tasks parser |
| `record_task_evidence` | evidence store (Phase G) |
| `sync_tasks` | `spec sync` (Phase H) |
| `verify_spec_drift` | `spec verify` (Phase H) |
| `export_agent_context` | `spec context` |

## Why wait

MCP multiplies every behavior across another surface. Locking the semantics
in the CLI first (with its test suite and exit-code contract) means the MCP
server inherits correct behavior instead of forking it.
