# Managed local model (llama.cpp)

SpecBridge can manage a local llama.cpp server as the inexpensive reasoning
tier for long-running jobs: classification, planning, critique, diagnosis,
and replanning run against a model on your machine, and only complex work
and actual implementation reach Claude Code. One managed server serves
every logical role — roles are prompts, not processes.

The local model is a **worker**, never an authority: its answers are
schema-validated structured proposals that deterministic policy accepts,
gates, or overrides. It cannot write the repository, approve anything, or
complete a task, and a local model crash is classified as a worker failure
— never as a failure of the task it was reasoning about.

## Setup

Configure two paths once, in `.specbridge/config.json` (never in `.kiro`,
which stays free of machine-specific configuration):

```json
{
  "localInference": {
    "enabled": true,
    "executable": "C:/tools/llama.cpp/llama-server.exe",
    "model": "D:/models/planner.gguf"
  }
}
```

Then check it:

```
specbridge local-model doctor          # files, coherence, startability
specbridge local-model status          # doctor + /health probe (fixed port)
```

Both are read-only: no server is spawned and no inference of any kind runs
from a doctor command. The orchestrator starts the server lazily on the
first local role, shares it across roles, stops it after
`idleShutdownMs` of quiet, and always stops it on exit.

## Options (all optional, with safe defaults)

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `0` | `0` allocates a free loopback port per start |
| `contextSize` | `8192` | context window (`-c`) |
| `parallel` | `2` | server slots (`-np`) shared by the roles |
| `gpuLayers` | absent | `-ngl` when set |
| `temperature` | `0` | sampling for role requests |
| `startupTimeoutMs` | `180000` | model-load deadline |
| `requestTimeoutMs` | `180000` | per-request deadline |
| `idleShutdownMs` | `300000` | quiet period before shutdown |
| `maxRestarts` | `1` | bounded lazy restarts after an unexpected exit |
| `maximumInputCharacters` | `48000` | packet ceiling; larger packets escalate |
| `extraArgs` / `executableArgs` | `[]` | extra llama-server arguments |

## Security

- The server binds to `127.0.0.1` **only**. The bind address is not a
  configuration value; `--host`, `--port`, `-m`/`--model`, and
  credential-related flags are rejected inside `extraArgs` and
  `executableArgs` at parse time, so configuration cannot rebind or
  re-point the managed process.
- argv arrays only; no shell ever sees these values. Paths are validated
  for existence at start time and never copied into the repository.
- stdout/stderr are captured into a bounded ring (`maxLogBytes`); requests
  and responses are size- and time-bounded through the same safe HTTP
  client every other model API uses.
- Structured output uses OpenAI-style `json_schema` constrained decoding
  where the endpoint supports it, with full client-side validation of the
  COMPLETE response either way — no substring extraction, no silent repair
  of malformed output; one bounded correction round, then escalation.
- No credentials exist anywhere in this feature, and nothing requires
  network access.

## Failure semantics

| Event | Consequence |
| --- | --- |
| executable/model missing | the role escalates (`LOCAL_WORKER_UNAVAILABLE`); doctor says exactly what to fix |
| startup timeout / crash | manager marked failed; ONE lazy restart on the next request (bounded by `maxRestarts`) |
| crash mid-request | one restart-and-retry; then the role escalates (`REPEATED_LOCAL_FAILURE`) |
| invalid structured output | one correction round; then sticky escalation (`INVALID_LOCAL_OUTPUT`) |
| packet exceeds `maximumInputCharacters` | immediate escalation (`CONTEXT_LIMIT_EXCEEDED`) — meaning is never truncated silently |

In every case the source task is untouched: escalation reroutes the
*reasoning*, and the job continues.

## Local task execution (vNext.2)

With the quota-aware scheduler enabled (the default), the same managed
endpoint also serves as the **LOCAL execution lane** for suitable tasks:
SpecBridge requests one structured implementation (complete replacement
file contents), validates and applies it itself, and completes through the
normal trusted-verification evidence pipeline. Local execution attempts
are bounded (`orchestration.jobs.scheduler.maxLocalAttempts`, default 2)
before the task escalates to the strong lane. See
[orchestration/quota-scheduling.md](orchestration/quota-scheduling.md) for
the lane model and suitability rules.

Since vNext.4 the LOCAL lane has a second execution **mode**: the same class
of local model can instead be driven by a harness runtime that inspects,
edits, and runs commands in the repository itself, inside one bounded
attempt. It is a mode, not a lane — same economics, same shared attempt
budget, same evidence pipeline — and it is off by default. See
[orchestration/local-agentic-runtime.md](orchestration/local-agentic-runtime.md).
