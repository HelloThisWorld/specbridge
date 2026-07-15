# MCP server

SpecBridge ships a local MCP (Model Context Protocol) server that exposes
the same core packages the CLI uses — as typed tools, read-only resources,
and workflow prompts. **MCP is an adapter, not the core**: every handler in
`packages/mcp-server` is a small wrapper over `@specbridge/core`,
`compat-kiro`, `workflow`, `execution`, `evidence`, and `drift`. No
workflow, verification, Git, evidence, approval, or Markdown-writing logic
is duplicated, so CLI and MCP can never disagree about semantics.

## Protocol and SDK

| Fact | Value |
| --- | --- |
| SDK | `@modelcontextprotocol/sdk` **1.29.0** (pinned exact) |
| Protocol baseline | **2025-11-25** (current stable revision; negotiation is the SDK's job) |
| Transport | **stdio only** in v0.5 (no HTTP, SSE, WebSocket, or OAuth) |
| Server identity | `{ "name": "specbridge", "version": "0.5.0" }` |

SDK-specific code is isolated to `packages/mcp-server` (server assembly,
transport, and the thin per-tool adapters); application types never import
SDK types, so upgrading the protocol later touches one package. Nothing
implements JSON-RPC framing by hand, and no draft-only SDK API is used.

## Commands

```text
specbridge mcp serve [--stdio] [--project-root <path>]
                     [--log-level silent|error|warn|info|debug] [--json-logs]
specbridge mcp doctor   [--json] [--verbose]    # read-only diagnosis
specbridge mcp manifest [--json]                # identity + capability counts
specbridge mcp tools    [--json] [--verbose]    # tool/resource/prompt catalog
```

v0.7.0 adds five template tools: read-only `template_list`,
`template_search`, `template_show`, and `template_preview`, plus the
candidate-hash-bound `template_apply` (acknowledgement-gated, atomic,
never overwriting). Template install/uninstall/scaffold remain CLI-only.

v0.6.1 adds four read-only runner diagnostic tools (`runner_list`,
`runner_show`, `runner_doctor`, `runner_matrix`) — thin adapters over the
same shared runner services the CLI uses; see [mcp-tools.md](mcp-tools.md).
They keep the stdio protocol clean (logs go to stderr only), redact
credential-shaped values, never expose environment-variable values, never
make an inference request, and remain strictly read-only.

`mcp serve` defaults to stdio. `mcp doctor` validates the project root,
`.kiro` availability, `.specbridge` configuration, package and protocol
versions, registry integrity, stdio cleanliness, plugin bundle paths (when
run from an installed plugin), and the Node.js version — without starting a
transport or writing anything.

## Project-root resolution

One server process serves exactly one project root, resolved at startup in
this order:

1. `--project-root <path>`
2. `SPECBRIDGE_PROJECT_ROOT`
3. `CLAUDE_PROJECT_DIR` (set by Claude Code for plugin MCP servers)
4. the current working directory

The resolved path is canonicalized (symlinks resolved), must exist and be a
directory, and rejects null bytes. `.kiro` workspace discovery then uses the
same walk-up logic as the CLI — and once a workspace resolves, its root is
**pinned**: no tool argument can move the server to a different project, and
a workspace that later resolves elsewhere is an error, never silently
adopted. Starting outside a valid directory fails with an actionable stderr
message and exit code 1.

## Stdio discipline

- stdout carries MCP protocol frames **only** — no banners, no logs.
- Every log line goes to stderr through the structured logger
  (`--json-logs` for machine-readable lines); `console.log` does not appear
  in server runtime code, and `mcp doctor` verifies that constructing the
  full server writes zero bytes to stdout.
- Uncaught exceptions are logged to stderr and exit non-zero.
- SIGINT and SIGTERM close the transport and exit 0 deterministically.
- Request cancellation propagates: the per-request `AbortSignal` reaches
  verification command execution, so a cancelled request terminates its
  child processes.

## Concurrency

Read-only requests run concurrently. Every state-changing tool serializes
through a per-project write mutex inside the server, and interactive task
execution is additionally guarded by the repository-local lock file
(`.specbridge/locks/interactive-task.lock`) so two *processes* cannot run
conflicting interactive work either. See
[interactive-task-execution.md](interactive-task-execution.md).

## Observability

Structured stderr events: `server_started`, `server_stopped`,
`tool_started`, `tool_completed`, `tool_failed`, `tool_cancelled`,
`resource_read`, `prompt_requested`, `interactive_run_started`,
`interactive_run_completed`, `interactive_run_aborted` — with timestamp,
level, request id, tool name, duration, error code, and run id where
applicable. Logs never contain spec contents, source contents, candidate
Markdown, prompts, environment values, secrets, or command output; stack
traces appear only at `--log-level debug`.

## Testing with MCP Inspector

```text
pnpm build
pnpm mcp:inspect
```

`mcp:inspect` starts the built stdio server under the official MCP
Inspector (downloaded on demand by `npx`; not required for any build or
test). No remote transport exists for Inspector use — it speaks stdio like
every other client.

## Error model

Ordinary failures come back as tool results with `isError: true` and a
stable envelope: code (`SBMCP001`–`SBMCP020`), category, actionable
message, remediation steps, and structured details. Protocol-level errors
are reserved for malformed requests and schema-invalid arguments (rejected
by the SDK before a handler runs). Stack traces never appear in responses.

| Code | Meaning |
| --- | --- |
| SBMCP001 | workspace not found |
| SBMCP002 | invalid tool input |
| SBMCP003 | spec not found |
| SBMCP004 | stage not applicable |
| SBMCP005 | approval stale |
| SBMCP006 | approval required |
| SBMCP007 | task not found |
| SBMCP008 | task already complete |
| SBMCP009 | dirty working tree |
| SBMCP010 | interactive run already active |
| SBMCP011 | run not found |
| SBMCP012 | run state invalid |
| SBMCP013 | repository diverged |
| SBMCP014 | verification failed |
| SBMCP015 | protected path modified |
| SBMCP016 | candidate analysis failed |
| SBMCP017 | current document hash mismatch |
| SBMCP018 | input too large |
| SBMCP019 | output too large |
| SBMCP020 | internal runtime failure |

## Output limits

| Bound | Value |
| --- | --- |
| List page size | 50 default, 200 maximum (`limit` + `cursor` pagination) |
| Document content | 1 MB |
| Candidate Markdown input | 1 MB |
| Structured response | 2 MB |
| Diagnostics per response | 500 |

Truncation is always explicit (a `truncated` flag and, for lists, a
continuation cursor); JSON output is never cut mid-document.

## Client compatibility

The server uses only stable, broadly supported MCP features — tools with
input/output schemas and annotations, resources with templates, prompts with
arguments, stdio transport — so any MCP client that speaks a supported
protocol revision can use it. The prompts exist specifically for non-Claude
clients (see [mcp-prompts.md](mcp-prompts.md)). Claude Code users get the
richer plugin experience ([claude-code-plugin.md](claude-code-plugin.md)).
