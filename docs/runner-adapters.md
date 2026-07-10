# Runner adapters

Runners are how SpecBridge stays model- and agent-agnostic: one interface,
many backends. **No default command requires a runner** — everything in v0.1
works offline with no API key.

## Interface

```ts
interface AgentRunner {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  generate(input: AgentGenerationInput): Promise<AgentGenerationResult>;
  executeTask?(input: TaskExecutionInput): Promise<TaskExecutionResult>;
}
```

`generate` produces or refines spec documents; `executeTask` (optional)
drives implementation of a single task. Inputs carry pre-assembled context
from `specbridge spec context` — runners never assemble context themselves.

## Status

| Runner | `isAvailable` | `generate` | Notes |
| --- | --- | --- | --- |
| `mock` | ✅ always true | ✅ deterministic, offline | Used by tests and dry runs |
| `claude-code` | ✅ real (probes the `claude` CLI) | ❌ NOT_IMPLEMENTED until Phase F | Never required by tests |
| `codex` | ✅ real (probes the `codex` CLI) | ❌ NOT_IMPLEMENTED until Phase F | |
| `ollama` | ❌ returns false | ❌ stub | Clearly marked; no fake implementation |
| `openai-compatible` | ❌ returns false | ❌ stub | Clearly marked; no fake implementation |

Unimplemented paths throw `NOT_IMPLEMENTED` with the planned phase — they
never fabricate output.

## Configuration

`.specbridge/config.json`:

```json
{
  "defaultRunner": "claude-code",
  "runners": {
    "claude-code": { "command": "claude" },
    "codex": { "command": "codex" }
  }
}
```

Only command names/paths belong here. **API keys are never stored in
SpecBridge configuration or logs**; API-based runners (when implemented) will
read credentials from the environment at invocation time.

## Safety requirements (all runners, current and future)

1. Runner execution is explicit — a user types `--runner` or configures a
   default; SpecBridge never invokes a model as a side effect.
2. Never execute commands suggested by model output. Verification commands
   come from trusted project configuration or explicit user input.
3. Never log secrets or environment variables.
4. Record command, duration, and exit status for every invocation (run
   records, Phase G).
5. Pass context via files or stdin, not command-line arguments (argv leaks
   into process listings).

## Adding a runner

Implement `AgentRunner` in `packages/runners/src/<name>-runner.ts`, register
it in `createDefaultRunnerRegistry`, and add tests under `tests/runners/`.
If you cannot implement it fully, ship an honest stub like
`ollama-runner.stub.ts` — availability `false`, generation
`NOT_IMPLEMENTED`.
