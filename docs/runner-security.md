# Runner security

The v0.6 multi-runner platform keeps every v0.3–v0.5 security guarantee and
extends it across providers. The controls below are enforced in code and
covered by tests.

## No credentials, ever

- SpecBridge stores no credential values; configuration rejects
  credential-looking keys outright.
- No provider credential files or private auth JSON are ever read;
  authentication status comes only from official safe commands (`claude
  auth status`, `codex login status`) and is otherwise `unknown`.
- Detection summarizes authentication output; it never echoes it (probe
  output can contain account details or tokens).
- Argv audit records redact configured sensitive values; environment
  variables are never logged or dumped into artifacts.

## No permission or sandbox bypasses

- Claude: `bypassPermissions` / `--dangerously-skip-permissions` are
  rejected at the configuration schema, argv assembly, and pre-spawn
  assertion. Unchanged from v0.3.
- Codex: `danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`,
  `--yolo`, and `--skip-git-repo-check` are rejected at the same three
  layers. Authoring always runs `--sandbox read-only`; task execution
  always runs `--sandbox workspace-write` (narrowable to read-only, never
  broadenable).
- Ollama: no repository access exists to bypass — the adapter has no file
  APIs and refuses task execution before any request.

## No shell interpolation

Runner commands and trusted verification commands are argv arrays executed
without a shell; null bytes and shell command strings are rejected at the
schema. Model output is never executed.

## Provider claims are not evidence

Reported changed files, commands, tests, and completion claims are recorded
as claims. Task completion authority remains: actual Git snapshots, actual
repository changes, trusted verification commands, valid SpecBridge
evidence, and explicit manual acceptance. No runner can mark a task
complete; protected-path (`.kiro`, `.specbridge`, `.git`, configured paths)
modifications keep the task unverified and are never auto-reverted.

## Bounded processes and requests

Timeouts, AbortSignal cancellation, forced child-process termination,
stdout/stderr byte caps, HTTP response caps enforced mid-stream, and
temporary prompt/schema file cleanup on every outcome. Truncated structured
output is never treated as valid.

## Reasoning stays private

Provider reasoning/thinking content is never normalized as assistant
content, never written to reports, and redacted from retained raw
artifacts; only redaction status and token counts survive.

## Auditable, append-only history

Runs and per-invocation attempt records are append-only; failed attempts
survive fallback; events are size-limited; errors are normalized with safe
messages (no stack traces, no raw provider payloads).

## No autonomy escalation

No automatic provider switching during task execution, no automatic
retries after possible repository modification, no automatic fallback
(explicit authoring chains only), no automatic commits/pushes/rollbacks,
no automatic model pulls or selection, no speculative parallel racing.
