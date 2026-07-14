# Antigravity CLI adapter (experimental)

The `antigravity-cli` adapter (v0.6.1) is EXPERIMENTAL: it detects the
executable (default `agy`, configurable), its version, and any DOCUMENTED
headless or machine-readable capabilities, and reports them transparently.
It is not a production automation adapter, and it cannot be marked
production in v0.6.1.

## What it never does

- start the interactive TUI (during doctor or ever)
- allocate a pseudo-terminal, inject keystrokes, or parse ANSI screen
  output (no PTY/TUI library exists anywhere in the implementation —
  enforced by tests)
- automate login or workspace trust
- inspect private session files
- assume Gemini CLI flags, output formats, or session storage —
  Antigravity is a different product
- claim task execution, resume, or structured output without detection
- get selected automatically (experimental profiles require explicit
  opt-in, and the profile is disabled by default)

## Profile

```json
{
  "runnerProfiles": {
    "antigravity": {
      "runner": "antigravity-cli",
      "enabled": false,
      "command": { "executable": "agy", "args": [] },
      "experimental": true
    }
  }
}
```

`experimental` is locked to `true` by the schema.

## Detection

`specbridge runner doctor antigravity` runs bounded `--version` and
`--help` probes with no stdin connected. A build that hijacks these into an
interactive session simply hits the bounded timeout and is classified as
interactive-only. Where the help output documents them, these observations
are reported (never acted on): headless invocation, machine-readable
output, structured final output, sandbox/permission controls,
workspace-write controls, session identity, resume.

Typical output:

```
Runner: antigravity
Support: experimental

Detected:
  executable
  version
  interactive workspace support

Not proven:
  stable headless mode
  structured final output
  bounded edit permissions
  session resume contract

Automation is disabled.
```

## Support rules

- category: `experimental`; support level: `experimental`
- every capability is declared false: stage generation, refinement, task
  execution, and resume are all refused by selection before any process
  could start (and again defensively by the adapter)
- even when headless/structured tokens are positively detected, support
  stays experimental in v0.6.1: a documented, headless, structured-output
  contract must pass the applicable conformance suite before any operation
  can be considered, and conformance can never confirm production for an
  experimental-declared adapter
