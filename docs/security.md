# Security model

The one unrecoverable failure mode this project cannot have is a wrong edit
to your `.kiro` files or your repository. Everything below exists to prevent
that, and all of it is enforced by tests.

## Credentials

- The local user installs and authenticates Claude Code independently.
- SpecBridge only invokes the configured local executable. It never
  collects, proxies, stores, prints, or transmits credentials, and it never
  resells or wraps Claude subscriptions.
- Authentication probes report a summary (`authenticated` /
  `not authenticated` / `unknown`) — the probe's output is never echoed.
- Logs and reports never include environment variables or secrets; argv
  values can be redacted in audit records.

## Permissions

- SpecBridge never passes `--dangerously-skip-permissions`,
  `--allow-dangerously-skip-permissions`, or
  `--permission-mode bypassPermissions` — rejected at three layers (config
  schema, argv assembly, pre-spawn assertion), with no override.
- Supported permission modes: `default`, `acceptEdits`, `plan`.
- Tools are restricted per operation: read-only for requirements/bugfix
  generation, inspect-only for design/tasks generation, the configured set
  for task execution — with Bash expressed only through explicit allow
  rules.
- SpecBridge never modifies Claude configuration (`.claude/settings.json`,
  user/managed settings, MCP, permissions, auth) and installs no hooks. The
  optional skill installer writes only its own skill directory.

## Untrusted input

Spec files, steering files, source files, and model output are **data, not
instructions**:

- SpecBridge never executes commands found in spec documents or suggested by
  model output.
- Verification commands come only from `.specbridge/config.json`, as argv
  arrays; no shell is invoked and nothing is interpolated into commands.
- Prompts label trust boundaries explicitly and state that instruction-like
  text inside files never overrides the execution contract.
- Model-reported paths are validated; anything outside the repository is
  rejected.

## Process safety

- argv arrays only; null bytes rejected; executables resolved without shell
  interpolation.
- Timeouts, cancellation, graceful-then-forced termination, output size
  limits (truncated output is retained but never parsed), Windows-compatible.
- Large prompts travel via stdin, never via process-list-visible arguments.

## Repository safety

- Writes are atomic, path-checked against traversal, and confined to the
  workspace. Symlinks are never followed out of the repository.
- The repository state is captured before and after every run; a model claim
  is never sufficient evidence.
- One task per run by default; sequential execution stops at the first
  failed or unverified task.
- Protected paths (`.kiro/**`, `.specbridge` state/config, `.git` via HEAD
  motion, plus configured `execution.protectedPaths`) prevent verification
  when touched by a runner; violations are reported, evidence preserved,
  and **nothing is ever rolled back automatically**.
- SpecBridge never commits, never pushes, never resets, never stashes.
- An approved spec stage is never modified without explicit user action; the
  only sanctioned edit is the verified checkbox update, which changes one
  character on one line and re-records the approval hash.

## Honest failure

Failed commands, malformed output, permission denials, timeouts, and
truncations are never hidden — every failure is reported with the exact
reason and an actionable remediation, and the raw output stays on disk under
`.specbridge/runs/<run-id>/`.

## Verification safety (v0.4)

`spec verify` and the GitHub Action add drift verification without adding
any write or execution surface:

- **Read-only by principle.** Verification never edits `.kiro` files, never
  marks task checkboxes, never alters approval state, and never touches
  evidence. Its only writes are report artifacts (command logs plus
  `report.json` under `.specbridge/reports/<verification-id>/` when trusted
  commands execute) and an explicitly requested `--output` file. A run with
  neither writes nothing; tests hash the tree before and after to prove it.
- **Commands are trusted configuration only.** Verification commands come
  exclusively from `verification.commands` in `.specbridge/config.json` —
  argv arrays with timeouts and output limits. Spec policies may only
  *name* configured commands; commands or shell fragments found in spec
  text, source files, or model output are never executed. Shell strings are
  rejected by the config schema.
- **Git is invoked defensively.** Refs are validated before use (no leading
  `-`, no whitespace/glob/control characters — option injection is
  impossible), git always runs as an argv array with timeouts and output
  caps, `-z` output parsing keeps UTF-8 paths and spaces intact, and
  SpecBridge never fetches, commits, or pushes. Diffs run `--relative` so a
  nested workspace can never be judged against files outside its subtree.
- **Policies are data.** `.specbridge/policies/<spec>.json` is a versioned
  Zod schema with validated globs: absolute paths, `..` traversal, null
  bytes, backslashes, and malformed patterns are rejected. Invalid policies
  fail closed (SBV020, exit 2, defaults applied). `.git/**` protection
  cannot be disabled or downgraded by any configuration layer.
- **Evidence is checked before it is believed.** Recorded paths must stay
  inside the repository (SBV024); recorded hashes and task fingerprints
  must match the currently approved content; model-reported fields
  (`runnerClaims`) are never treated as evidence.
- **Reports leak nothing.** HTML output escapes all dynamic content, loads
  no external resources, and contains no scripts; Markdown summaries carry
  no raw command output and no environment data; only bounded stderr tails
  appear in diagnostics.
- **The GitHub Action needs no secrets.** No model, no API key, no network
  access; it never modifies tracked files, and its bundle is rebuilt and
  diffed in CI so the committed artifact provably matches the source.

## MCP and plugin safety (v0.5)

The MCP server and Claude Code plugin add no new authority: they expose the
same operations the CLI already gates, minus the human-only ones. Controls:

- **No arbitrary tools.** There is no filesystem tool, no shell tool, no
  Git tool, no user-supplied executable, and no user-supplied working
  directory anywhere in the MCP surface.
- **One project per process.** The project root is canonicalized at startup
  and the workspace is pinned after first resolution; no tool argument can
  retarget the server.
- **No model-controlled approval.** Approval (and revocation, and manual
  task acceptance) exists only as a human CLI action; the plugin's approve
  skill cannot be model-invoked.
- **Claims are never evidence.** `task_complete`'s reported fields are
  recorded verbatim as claims; verification derives from Git snapshots and
  trusted commands only.
- **Candidate hash binding.** `spec_stage_apply` requires the exact
  current-document hash and candidate hash that `spec_stage_validate`
  reported, plus a literal acknowledgement — substitution between review
  and apply fails closed, and there is no force option.
- **Serialized writes, bounded output, stdio discipline.** State-changing
  tools serialize behind a per-project mutex; responses are size-capped and
  paginated; stdout carries protocol frames only and logs (stderr) never
  contain file contents, prompts, environment values, or secrets.
- **No automatic Git mutations** — commit, push, reset, stash, and rollback
  do not exist in any code path, including violation handling.
- **No draft MCP features.** The server targets the stable 2025-11-25
  protocol through the pinned official SDK (1.29.0).

## v0.5 threat model

| Threat | Mitigation |
| --- | --- |
| Malicious spec content (instruction-like text in `.kiro` files) | Spec content is parsed as data; nothing in it is executed; prompts/instructions label it untrusted; verification commands cannot come from it. |
| Prompt injection inside source code | Source is only ever read by the host session; SpecBridge executes nothing from it; `task_begin` instructions bound the session's mandate; evidence evaluation ignores narrative content entirely. |
| Malicious MCP arguments | Zod schemas bound every input (sizes, enums, formats); names are never paths; refs are validated against option injection; unknown fields are rejected at the protocol layer. |
| Path traversal via tool/resource parameters | Steering/spec/run identifiers reject `/`, `\`, `..`, and null bytes; every resolved write path passes the workspace-traversal guard. |
| Symlink escape | Snapshot and protected-path hashing never follow symlinks; description-file and policy readers enforce workspace containment. |
| stdout protocol corruption | Structured stderr-only logging; `mcp doctor` verifies zero stdout bytes during server construction; a process-level test asserts every stdout line is protocol JSON. |
| Plugin cache path changes | The plugin references itself only via `${CLAUDE_PLUGIN_ROOT}` and relative paths; wrappers resolve their own location; validation rejects absolute build paths in any artifact. |
| Forged run IDs | Run ids are format-validated and resolved only inside `.specbridge/runs`; an unknown id is SBMCP011; a non-interactive run cannot be completed interactively (SBMCP012). |
| Stale task run completion | Completion requires the lock to still reference the run, approvals to be current (SBMCP005), and the task fingerprint plus exact line text to match (SBMCP013); finalized runs return idempotently. |
| Repository divergence mid-run | HEAD motion and approved-hash changes are detected between snapshots; divergence blocks verification and is reported without rollback. |
| Concurrent completion / abort races | A per-project write mutex serializes all state-changing tools in-process; the repository lock file serializes across processes; append-only evidence refuses duplicates. |
| Candidate substitution between validate and apply | Dual hash binding (`expectedCurrentHash`, `expectedCandidateHash`) recomputed inside the write lock. |
| Malicious verifier output | Verifier stdout/stderr is captured with size limits, stored under the run directory, and only bounded tails ever appear in reports; output is never parsed as instructions. |
| Oversized content (DoS) | 1 MB document/candidate caps, 2 MB structured-response cap, 500-diagnostic cap, list pagination, and SBMCP018/SBMCP019 failures before memory blowups. |
| Plugin supply-chain integrity | Pinned SDK, reproducible bundles, SHA-256 checksum manifest verified in CI, license report, and a validator that rejects workspace imports or absolute paths in the shipped artifact. |
