# Plugin security

The Claude Code and Codex frontend plugins inherit every SpecBridge guarantee
([security.md](security.md)) and add the MCP/plugin-specific controls below. Read this together with
the v0.5 threat model in [security.md](security.md).

## What the plugin can never do

| Control | Enforcement |
| --- | --- |
| No arbitrary filesystem access via MCP | No such tool exists; document tools address well-known names only; template variables reject path syntax; every write goes through the workspace-traversal guard. |
| No arbitrary shell/Git access via MCP | No such tool exists. The only commands the server ever executes are the trusted verification commands from `.specbridge/config.json` — argv arrays, validated schema, timeouts, output limits. MCP arguments and spec content can never supply a command or a working directory. |
| No model-controlled approval | Approval is not an MCP tool or prompt. Claude's `approve` skill sets `disable-model-invocation: true` and requires final confirmation before its narrow bundled CLI command. Codex's stricter adapter never executes approval: it prints the exact command for the human's terminal and stops. |
| No nested agents | The interactive lifecycle runs in the current session. Skills and interactive execution code are scanned (validation + tests) for `claude -p`, `codex exec`, `spec run`, runner-registry usage, and process spawning. |
| No project switching | One server process serves one canonicalized project root; the workspace is pinned after first resolution. |
| No stdout corruption | stdout carries protocol frames only; all logs go to stderr (verified by `mcp doctor` and a process-level test). |
| No secret exposure | No environment dump exists; `.specbridge/config.json` is never returned raw (only a redacted status); run views exclude prompts, raw runner output, and command logs; logs carry safe metadata only. |
| No permission bypasses | `bypassPermissions` / `dangerously-skip-permissions` are rejected at the config schema (v0.3 control) and forbidden in every skill (validated). |
| No automatic Git mutations | Nothing commits, pushes, resets, stashes, or rolls back — including after protected-path violations, which are reported instead. |
| Bounded everything | 1 MB documents/candidates, 2 MB structured responses, 500 diagnostics, paginated lists; oversized inputs fail with SBMCP018 before any work. |

## The skills' permission surface

- All Claude skills except `approve` declare **no** `allowed-tools`: they use
  the plugin's MCP tools under Claude Code's normal permission system.
- The Claude `approve` skill declares exactly one narrow allowance —
  `Bash("${CLAUDE_PLUGIN_ROOT}/bin/specbridge" spec approve *)` — for the
  bundled CLI's approval command. If a host does not expand the variable in
  frontmatter, the command simply falls back to a normal permission prompt:
  the failure mode is *more* confirmation, never less.
- Codex skills use only current native `name` and `description` frontmatter.
  The Codex `approve` skill has no execution allowance, instructs Codex never
  to run either approval command, prints the human terminal command, and
  stops. Deterministic tests enforce that contract.
- No skill instructs editing `.kiro` or `.specbridge` directly, and the
  validator rejects any line that mentions doing so without negating it.

The Codex frontend installs no hooks and injects no `AGENTS.md`. It does not
read Codex credentials, enable `codex-default`, or weaken Codex sandbox and
approval policies. Its MCP launcher uses `shell: false` and keeps the plugin
cache separate from the canonical project root.

## Supply-chain integrity

- The bundles are reproducible (no timestamps, no absolute paths, no source
  maps) and shipped with SHA-256 manifests; `pnpm validate:plugin` and
  `pnpm validate:codex-plugin` recompute the hashes and plugin tests verify
  them in CI. Shared CLI/MCP bytes must be identical across both frontends.
- `THIRD_PARTY_LICENSES.txt` lists every bundled external package with its
  license text.
- The MCP SDK is pinned exactly (`1.29.0`); dependency updates are explicit
  diffs, never floating ranges, for the bundled artifact.
- The release ZIP excludes source maps, tests, `node_modules`, `.git`,
  `.kiro`, `.specbridge`, and logs (enforced by the packer and re-checked by
  the validator).

## Residual risks (documented, not hidden)

- The plugin executes with the user's local permissions; a malicious
  `.specbridge/config.json` **that the user writes** can name any local
  command as a verification command. That file is trusted project
  configuration by design — review it like CI configuration.
- Spec Markdown and source code are untrusted *data*. SpecBridge never
  executes anything found in them, but the host model still reads them;
  prompt-injection resistance of the host model itself is outside
  SpecBridge's control. The instructions returned by `task_begin` explicitly
  bound what the session should do.
- Lock-file recovery (`specbridge run recover-lock --remove`) is powerful
  by nature; it therefore demands positive staleness evidence plus an
  explicit flag, and never runs automatically.
