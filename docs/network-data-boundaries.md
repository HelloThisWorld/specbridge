# Network and data boundaries

SpecBridge classifies every runner profile by where its work happens and
shows the boundary before anything runs.

## Boundary classes

| Boundary | Meaning | Examples |
| --- | --- | --- |
| `in-process` | deterministic mock; nothing leaves the process | mock |
| `local-process` | a local child process; the provider CLI handles its own connectivity with its own authentication | claude-code, codex-cli |
| `loopback-endpoint` | SpecBridge sends HTTP to 127.0.0.1/localhost/[::1]; inference stays on this machine | ollama-local |
| `network-endpoint` | SpecBridge sends spec content to a configured remote endpoint | remote Ollama profile |

Attempt records store the boundary; runner plans and `runner list/show`
print it. Network-backed profiles are clearly identified everywhere.

## Selection consequences

Network-backed profiles require explicit selection (`--runner`) or an
operation default — the global default alone never reaches them
(`runnerPolicy.requireExplicitRunnerForNetworkAccess`, on by default).
`allowNetworkRunners: false` refuses them outright. Nothing is ever
selected merely for being available, and local-to-network fallback happens
only when the chain explicitly names the network profile.

## What is sent where

Authoring prompts contain: steering documents, the relevant spec stages,
the refinement instruction, and repository observations already selected by
the shared authoring logic. Agent CLIs additionally read the repository
themselves under their own bounded tools/sandbox.

Never sent by SpecBridge: `.env` files, credential files, raw provider
logs, unrestricted `.specbridge` state, arbitrary home-directory files, or
the full repository contents.

## Transport safety (model APIs)

- bounded request timeout + AbortSignal cancellation
- response size limits enforced while streaming (oversized bodies abort)
- redirects never followed (a redirect is a failure, not a hop)
- http(s) only; no embedded credentials; loopback by default; remote needs
  HTTPS or the labeled `allowInsecureHttp` development override
- JSON parsed defensively; unexpected content types rejected

## Dry runs

`--dry-run` never sends an HTTP request and never invokes provider print
mode. The printed plan includes the endpoint host, network classification,
model, document list, and approximate input size, so you can see exactly
what WOULD leave the machine before it does.
