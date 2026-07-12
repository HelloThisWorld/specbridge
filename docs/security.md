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
