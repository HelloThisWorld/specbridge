# Runner selection

Selection is deterministic. Precedence (first match wins):

1. Explicit CLI `--runner <profile>`
2. Spec-specific preference (reserved — the current architecture stores no
   per-spec runner preference)
3. Operation-specific default (`operationDefaults.stageGeneration`,
   `.stageRefinement`, `.taskExecution` — task resume follows task execution)
4. Global `defaultRunner`

SpecBridge never selects the "first available" runner, never selects a
network-backed runner merely because it is available, and never silently
switches providers after a failure.

## Operation defaults

```jsonc
{
  "operationDefaults": {
    "stageGeneration": "ollama-local",
    "stageRefinement": "ollama-local",
    "taskExecution": "claude-code"
  }
}
```

## The selection plan

Before execution, selection produces a plan: profile, implementation,
category, support level, operation, origin, required capabilities, declared
capabilities, local/network boundary, configured model, fallback chain, and
safety constraints. `spec generate --dry-run` / `--show-runner-plan` print
it; the JSON reports embed it.

## Refusals happen before anything runs

If the selected profile cannot perform the operation, SpecBridge stops
before any process spawn, HTTP request, run record, or file change:

```text
Cannot perform task-execution using "ollama-local": the ollama runner lacks required capabilities.

Required capabilities:
  taskExecution
  repositoryRead
  repositoryWrite
  structuredFinalOutput
  supportsCancellation

Detected capabilities:
  stageGeneration
  stageRefinement
  structuredFinalOutput
  supportsJsonSchema
  supportsCancellation
  ...

Compatible configured profiles:
  claude-code
  codex-default
```

Other refusals: unknown profile (`runner_not_found`), disabled profile
(`runner_disabled` — enable it explicitly), network-policy refusals (see
below), and preview/experimental profiles selected implicitly.

v0.6.1 adds no new selection rules — the new providers flow through the
existing engine: `gemini-default`, `openai-compatible-local`, and
`antigravity` default to disabled and are never selected implicitly;
task execution can never select `openai-compatible` or `antigravity`
(capability-refused before any request); the experimental `antigravity`
profile requires explicit opt-in even when enabled; and authoring
fallback may include Gemini or OpenAI-compatible only when the chain
explicitly names them. There is no automatic task-execution fallback and
no fallback after repository modification, authentication failure,
permission failure, or cancellation — unchanged.

## Network policy

`runnerPolicy` defaults:

```jsonc
{
  "runnerPolicy": {
    "allowAutomaticFallback": false,
    "allowNetworkRunners": true,
    "requireExplicitRunnerForNetworkAccess": true,
    "requireExplicitRunnerForPaidApi": true
  }
}
```

A network-backed profile (a model API on a non-loopback endpoint) is
selectable only explicitly (`--runner`) or through an operation default —
never through the global default alone. `allowNetworkRunners: false`
refuses network-backed profiles entirely.
