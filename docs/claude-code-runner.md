# Claude Code runner

The first production runner (v0.3) invokes the **locally installed Claude
Code CLI** in non-interactive print mode.

## Prerequisites — yours, not SpecBridge's

- You install Claude Code yourself (`npm install -g @anthropic-ai/claude-code`
  or the native installer).
- You authenticate it yourself (`claude auth login` or `claude login`,
  depending on your version).
- SpecBridge does not include Claude usage, never collects, stores, proxies,
  or prints credentials, and never transmits anything anywhere itself — it
  only spawns the executable you configured.

Check readiness at any time (read-only):

```sh
specbridge runner doctor claude-code
```

## Detection

Detection runs `--version`, `--help`, and — when the CLI documents it —
`auth status`, each with a timeout. Capabilities are detected by searching
help text for flag tokens rather than parsing one exact help layout, so
newer and older CLI versions degrade gracefully.

Required capabilities (missing ⇒ runner reported `incompatible`, execution
refused): non-interactive print mode, JSON output, tool restrictions, and a
non-bypass permission mode.

Optional capabilities (missing ⇒ warning + graceful degradation):
structured output (`--json-schema`), session ids, resume, `--max-turns`
(SpecBridge always enforces its own process timeout), `--max-budget-usd`.

Authentication output is summarized (`authenticated` / `not authenticated` /
`unknown`), never echoed — it could contain account details.

## Invocation

The argument vector is built as an **array** (no shell string, ever), only
from flags the installed version supports:

```
claude --print --output-format json
       --json-schema <run-dir>/tmp/output-schema.json
       --max-turns 30
       --permission-mode acceptEdits
       --allowedTools Read,Glob,Grep,Edit,Write,Bash(git status *),…
       --session-id <generated-uuid>
       [--model …] [--effort …] [--max-budget-usd …] [--setting-sources …]
```

- The prompt travels via **stdin**, never in a process-list-visible argument.
- Stage generation forces read-only tools (`Read,Glob,Grep`) and the
  `default` permission mode; task execution uses the configured tool set,
  with Bash expressed only through explicit allow rules.
- The following are **never** passed, rejected at three layers (config
  schema, argv assembly, pre-spawn assertion) and covered by tests:
  `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`,
  `--permission-mode bypassPermissions`.
- The working directory is the repository root; the environment is inherited
  from your shell (the local Claude installation needs its own auth
  environment) and is never logged.

## Process control

Every invocation has a configurable timeout, AbortSignal cancellation,
graceful-then-forced termination (Windows-compatible), and stdout/stderr
size limits. Output that exceeds a limit stops the run safely: the truncated
output is retained for audit and is never parsed as a valid result.

Recorded per invocation: executable, redacted argv, start/end time,
duration, exit code, termination signal, stdout/stderr (within limits),
timeout/cancellation flags, and the session id when available.

## Structured output

With `--json-schema` support, the final output is schema-constrained and
validated with the matching Zod schema. Without it, SpecBridge falls back to
extracting and validating JSON from the result text and reports the degraded
compatibility. Malformed output is never repaired or guessed at — the run
ends `malformed-output` with the raw output retained under
`.specbridge/runs/<run-id>/`.

A model-reported result is **never** treated as proof of completion — see
[execution evidence](execution-evidence.md).

## Costs and limits

Claude Code usage happens under *your* account and plan. Budget guards you
can set: `maxTurns`, `maxBudgetUsd` (when the CLI supports it), `timeoutMs`,
and per-run CLI overrides (`--max-turns`, `--max-budget-usd`, `--timeout`).
