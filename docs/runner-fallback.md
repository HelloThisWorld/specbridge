# Authoring fallback

Automatic fallback is DISABLED by default and exists only for the two
authoring operations — never for task execution or resume.

## Configuration (explicit, per operation)

```jsonc
{
  "fallbacks": {
    "stageGeneration": ["ollama-local", "codex-default"],
    "stageRefinement": []
  }
}
```

The chain is attempted in order after the selected profile fails with a
fallback-eligible outcome. Including a network-backed profile in the chain
IS the explicit opt-in for it — local-to-network fallback never happens
otherwise.

## Bounded retries within one profile

- at most ONE structured-output correction retry (adapters that declare
  correction support — Ollama; the correction prompt carries the validation
  problems, never secrets);
- at most TWO transient transport retries (network errors, unreachable
  endpoint, rate limit, timeout) with exponential backoff and bounded
  jitter.

## When fallback never happens

- task execution or resume (no automatic provider switch, ever)
- after the repository changed since the run started (verified against a
  working-tree fingerprint, not assumed)
- after authentication failure, permission denial, sandbox unavailability,
  invalid configuration, model-not-found, or quota exhaustion
- after explicit user cancellation
- to a disabled, unknown, or capability-incompatible profile
- on real results: `completed` and `blocked` are answers, not transport
  failures

There is no speculative parallel runner racing.

## Auditability

Every attempt — initial, correction retry, transport retry, fallback — gets
its own append-only record under
`.specbridge/runs/<run-id>/attempts/<attempt-id>/` with the profile,
capability snapshot, boundary, normalized result, and error classification.
Skipped candidates are recorded with their reason. Failed candidate outputs
(including invalid structured output) are retained for inspection and never
applied. The CLI prints every attempted profile and reason.
