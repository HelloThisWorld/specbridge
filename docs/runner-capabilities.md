# Runner capabilities

Runner behavior in SpecBridge is capability-driven: core orchestration never
branches on provider names. Before any process spawn or HTTP request, it
checks whether the selected profile's runner declares the capabilities the
requested operation needs.

## Categories

| Category | Meaning | v0.6.0 |
| --- | --- | --- |
| `agent-cli` | local coding-agent CLI; may modify sources under a bounded sandbox/tool restriction | claude-code, codex-cli |
| `model-api` | model endpoint; authoring only, no repository access | ollama |
| `mock` | deterministic in-process runner for tests/conformance | mock |
| `experimental` | reserved for detection-only integrations | (none) |

## Support levels

| Level | Meaning |
| --- | --- |
| `production` | complete implementation; all applicable conformance groups pass; documented security boundaries |
| `preview` | explicitly selectable only; documented limitations remain |
| `experimental` | detection or incomplete integration; never selected automatically |
| `unavailable` | required executable or endpoint is missing |
| `incompatible` | provider exists but required capabilities are unavailable |

Detection only downgrades: `runner doctor` shows the effective level.

## Capability keys

The seventeen stable keys (never a single `supported` boolean):

`stageGeneration`, `stageRefinement`, `taskExecution`, `taskResume`,
`structuredFinalOutput`, `streamingEvents`, `repositoryRead`,
`repositoryWrite`, `sandbox`, `toolRestriction`, `usageReporting`,
`costReporting`, `localOnly`, `requiresNetwork`, `supportsSystemPrompt`,
`supportsJsonSchema`, `supportsCancellation`.

`structuredFinalOutput` is declared only when the adapter's validated
structured result passed conformance — via provider JSON Schema constraining
or a conformance-proven validated fallback.

## Operation requirements

| Operation | Requires | Safe boundary (any of) |
| --- | --- | --- |
| stage-generation | stageGeneration, structuredFinalOutput, supportsCancellation | — |
| stage-refinement | stageRefinement, structuredFinalOutput, supportsCancellation | — |
| task-execution | taskExecution, repositoryRead, repositoryWrite, structuredFinalOutput, supportsCancellation | sandbox OR toolRestriction |
| task-resume | taskResume, taskExecution, structuredFinalOutput, supportsCancellation | sandbox OR toolRestriction |
| model-list | a provider-supported listing mechanism (models are never guessed) | — |
| runner-test | structuredFinalOutput, supportsCancellation | — |

A profile that cannot satisfy an operation is refused BEFORE anything runs,
with the missing capabilities and the compatible configured profiles listed
(see [runner-selection.md](runner-selection.md)).

## Usage and cost

Provider usage (tokens, request counts, duration) is normalized when
reported. Cost is never computed from hardcoded pricing: it is
`provider-reported`, `configured-estimate`, or `unavailable`. Local Ollama
runs report `unavailable` — local inference is not free, SpecBridge just
cannot price your hardware and electricity.
