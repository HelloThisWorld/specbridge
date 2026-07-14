# Gemini CLI runner

The `gemini-cli` runner (v0.6.1) invokes the locally installed [Gemini
CLI](https://github.com/google-gemini/gemini-cli) in headless mode through
the frozen v0.6.0 runner adapter contract. You install and authenticate the
Gemini CLI yourself; SpecBridge never embeds Google authentication, never
triggers an interactive login, never reads OAuth or credential files, never
modifies your Gemini settings or trusted-folder state, and never enables
extensions or YOLO mode.

## Profile

The built-in profile is `gemini-default`, DISABLED by default:

```json
{
  "runnerProfiles": {
    "gemini-default": {
      "runner": "gemini-cli",
      "enabled": false,
      "command": { "executable": "gemini", "args": [] },
      "model": null,
      "approvalModeForAuthoring": "plan",
      "approvalModeForExecution": "auto_edit",
      "sandbox": true,
      "allowedTools": [],
      "disabledExtensions": true,
      "timeoutMs": 1800000
    }
  }
}
```

- `approvalModeForAuthoring` accepts only `plan`; `approvalModeForExecution`
  accepts only `auto_edit` or `default`. `yolo` is not a value of either
  enum, is rejected by the config-wide forbidden-fragment check, and is
  refused again by the pre-spawn argument assertion.
- `allowedTools` may add extra tools for task execution; shell-execution
  tool names are rejected by the schema.
- The command is executable plus argv array; shell strings are rejected.

## Capability detection

`specbridge runner doctor gemini-default` runs bounded, read-only probes
(`--version`, `--help`) — never a model request, never a login, never a
trusted-folder change. Detection does not depend on one exact help layout;
it searches for tokens:

- headless prompt invocation (`--prompt`) — required
- machine-readable output (`--output-format` with `json`) — required
- streaming events (`stream-json`) — optional (JSON envelope fallback)
- approval-mode selection (`--approval-mode`) — required
- plan mode / auto_edit mode / sandbox / tool allowlist / extension
  restriction / model selection / session listing / explicit resume —
  optional, each degrading a specific capability

Authentication cannot be verified without a model request, so the doctor
reports it as `unknown`; `specbridge runner test gemini-default --network`
performs one minimal, bounded structured-output probe.

## Support levels for the installed version

Capabilities are downgraded from detection — never assigned from the
provider name:

| Situation | Result |
|-----------|--------|
| headless + JSON output + plan mode (or tool allowlist) | authoring is production |
| additionally auto_edit + (tool allowlist or sandbox) | task execution is production |
| additionally explicit `--resume <uuid>` support | task resume is available |
| no plan mode AND no tool allowlist | authoring incompatible (no read-only boundary) |
| no auto_edit, or neither allowlist nor sandbox | task execution incompatible (a bounded edit policy cannot be proven); authoring stays available |

When task execution is incompatible the doctor explains the exact gap and
recommends compatible `claude-code` or `codex-cli` profiles. The policy is
never relaxed and YOLO is never used as a workaround.

## Authoring boundary (read-only)

Stage generation and refinement run with:

- the `plan` approval mode (read-only) where supported,
- a repository-reading tool allowlist (`read_file`, `read_many_files`,
  `list_directory`, `glob`, `search_file_content`) where supported,
- `--sandbox` where supported, `--extensions none` where supported,
- the prompt via stdin (never in the process list),
- JSON or stream-JSON output.

The Gemini process never writes the `.kiro` target document. SpecBridge
receives the candidate Markdown as a strict JSON-only response, validates
the COMPLETE response with Zod (no Markdown fences, no substring
extraction, no guessing of missing fields), analyzes it, and applies it
atomically through the shared authoring logic. The candidate remains
unapproved. At most one structured-output correction retry runs, recorded
as a separate append-only attempt.

## Task execution boundary (bounded edits, no shell)

Task execution runs headlessly with `auto_edit`: file edits are the only
auto-approved action, and every other tool request — including
`run_shell_command` — is refused (there is no interactive approval in
headless mode, and shell tools are additionally excluded from the
allowlist). The Gemini CLI does not need shell access to satisfy the task
contract: trusted build/test/lint/typecheck commands remain SpecBridge
verification commands executed after the model exits.

Never used or permitted: YOLO, automatic workspace trust, commits, pushes,
resets, stashes, `.kiro` or `.specbridge` edits, checkbox updates.

Gemini tool events and reported test results are CLAIMS. Git state and
trusted verification remain authoritative: protected-path changes and
tasks.md edits are detected from snapshots and prevent verification, and a
malformed final result leaves the task unchecked with evidence preserved.

## Resume (explicit session identity only)

Resume happens only when the original run captured an explicit session
UUID, the installed version supports `--resume <uuid>`, the project root
matches, approvals and the task fingerprint are current, and the repository
state reconciles. `latest`, indexes, ambiguous identifiers, sessions from
other projects, and completed verified tasks are never resumed. If the
provider reports a different session identity during a resume, the
discrepancy is reported, the resume is not claimed successful, run lineage
is preserved, and the task stays unchecked.

## Events and reasoning boundary

Stream-JSON events are normalized into the shared event model
(session/tool/file-edit/usage/result/error). `thought` events are provider
reasoning: their text is never normalized, never retained (the raw stream
keeps only a length marker), and never surfaced anywhere.

## Known limitations

- Installed-version capabilities vary; the doctor reports exactly what was
  proven. Not every Gemini CLI version supports safe task execution.
- No native JSON-Schema-constrained output: structured output uses the
  strict JSON-only response contract with complete-response validation
  (the conformance-approved fallback).
- Model listing is not supported without a model request; configure
  `model` explicitly.
