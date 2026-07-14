# Runner conformance

The conformance framework is the proof behind every `production` support
level: a runner cannot be production unless all APPLICABLE groups pass.
Applicability derives from declared capabilities — a model-API runner is
never evaluated (and can never pass itself) into task execution.

## Groups

| Group | Applies to | Verifies |
| --- | --- | --- |
| detection | every runner | identity, category, complete capability set, support-level consistency, error diagnostics on failure, read-only behavior, no credential echo |
| structured-output | authoring-capable runners | schema-validated result, UTF-8 round trip |
| process-control | cancellation-capable runners | deterministic timeout and cancellation endings |
| stage-generation | authoring-capable runners | completed validated candidate, non-empty Markdown, NO workspace writes, no approval semantics |
| stage-refinement | authoring-capable runners | same guarantees for refinement |
| task-execution | agent CLI runners | end-to-end shared orchestration: verified evidence updates exactly one checkbox; a failed verifier leaves the checkbox unchanged; evidence comes from Git + trusted verification, not claims |
| resume | taskResume-capable runners | verified runs are never resumed; explicit session identity is required (no "latest" guessing); repository divergence blocks resume |

Provider-forced misbehavior (protected-path writes, false claims,
malformed output floods) cannot be commanded from a real provider on
demand; those scenarios run continuously in the fake-provider and
mock-runner test suites, and the orchestration protections they verify are
provider-independent.

## Running it

```bash
specbridge runner conformance mock                      # fully offline
specbridge runner conformance codex-default             # invocation checks skipped
specbridge runner conformance codex-default --network   # full suite (real provider)
specbridge runner conformance ollama-local --network --json
```

- Conformance always runs against a throwaway fixture workspace — never your
  repository.
- Without `--network`, checks that would invoke the provider (process spawn
  or HTTP request, possibly billable) are reported as skipped, and
  production status is NOT confirmed while required checks are skipped.
- CI runs the complete suite against fake providers (a real fake-Codex child
  process and a real loopback fake-Ollama HTTP server) — no real
  installation, network, model, or credentials required.

## Support-level consequences

- all applicable groups pass → `production` confirmed
- a documented optional capability fails → at best `preview`
- required production capabilities fail → `incompatible`
