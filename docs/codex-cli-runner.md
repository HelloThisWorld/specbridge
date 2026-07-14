# Codex CLI runner

The `codex-cli` implementation wraps a locally installed [Codex
CLI](https://github.com/openai/codex) in non-interactive `exec` mode with
machine-readable JSONL events.

## Installation and authentication are yours

You install the Codex CLI and authenticate it yourself (`codex login`).
SpecBridge never embeds authentication, never reads provider credential
files or private auth JSON, never stores API keys, never performs
interactive login, and never modifies your Codex settings. Authentication
status is probed only through the official `codex login status` command;
when the installed version exposes none, the doctor reports `unknown` and
`specbridge runner test <profile> --network` offers a minimal authenticated
probe.

Not every Codex version is compatible: detection probes the installed
version's actual capabilities and downgrades honestly (see below).

## Enabling it

The built-in `codex-default` profile ships DISABLED:

```jsonc
{
  "runnerProfiles": {
    "codex-default": {
      "runner": "codex-cli",
      "enabled": true,                      // ← your explicit opt-in
      "command": { "executable": "codex", "args": [] },
      "model": null,                        // provider default unless set
      "sandbox": "workspace-write",         // task execution boundary
      "persistSessions": true,
      "timeoutMs": 1800000
    }
  }
}
```

## Detection

`specbridge runner doctor codex-default` probes read-only (`--version`,
`--help`, `exec --help`, `login status`) — never a model request. It
detects: non-interactive `exec`, `--json` events, `--output-schema`,
`--output-last-message`, read-only and workspace-write sandbox modes,
`exec resume`, and model selection. Probes match capability tokens, not one
exact help layout. If workspace-write or reliable structured output is
missing, task execution is marked incompatible while authoring is preserved
when safe, and the exact missing capability is reported.

## Authoring mode (stage generation/refinement)

- always `--sandbox read-only`
- JSON Schema structured output via `--output-schema` where supported; the
  final agent message is validated against the report schema either way
- prompt via stdin (`codex exec … -`) — spec content never appears in the
  process list
- the provider returns candidate Markdown; SpecBridge validates it
  deterministically and writes the document atomically; nothing is
  auto-approved; referenced paths outside the repository are dropped

## Task execution mode

- `--sandbox workspace-write` (the profile may narrow to `read-only`; it can
  never broaden)
- never `danger-full-access`, never
  `--dangerously-bypass-approvals-and-sandbox`, never `--yolo`, never
  `--skip-git-repo-check` — rejected at the configuration schema, the argv
  builder, and a pre-spawn assertion
- never commits, pushes, resets, or stashes; never edits `.kiro/`,
  `.specbridge/`, or task checkboxes (and the shared evidence pipeline
  catches it if the provider tries)
- machine-readable events are captured and normalized; the provider
  session/thread id is recorded for resume
- Codex file-change and command events are CLAIMS; actual Git state is
  authoritative. Protected-path modifications keep the task unverified and
  are never auto-reverted.

## Resume

Resume uses the EXPLICIT recorded session id (`codex exec resume <id>`) —
the ambiguous "resume latest" form is never used. The shared resume gates
still apply: run lineage, spec approvals, task fingerprint, and repository
state must all validate; a missing provider session fails the attempt
honestly.

## Reasoning output

Codex reasoning items are never normalized as content and never copied into
reports — only redaction status and token counts are retained. Raw event
streams are kept in append-only attempt artifacts under the process output
limits.
