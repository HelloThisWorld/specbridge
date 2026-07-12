# GitHub Action

`integrations/github-action` is a production node20 action that runs the
same deterministic verification engine as `specbridge spec verify`. It is a
thin wrapper: no rule logic is reimplemented in the action.

**Requires no model, no API key, no Claude installation, no pnpm, and no
network access.** The committed `dist/index.js` bundle contains everything;
CI rebuilds it and fails when it drifts from the source.

## Setup

```yaml
name: Verify specs

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  specbridge:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Verify spec alignment
        id: specbridge
        # Replace <owner> with the repository owner once published.
        uses: <owner>/specbridge/integrations/github-action@v0.4
        with:
          mode: changed
          fail-on: error
          strict: false
          run-verification: true

      - name: Upload SpecBridge reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: specbridge-reports
          path: .specbridge/action-reports
```

### Shallow checkouts

`fetch-depth: 0` matters. The action **never fetches by itself**; when the
comparison base is missing from a shallow clone, the run fails with SBV021
and this exact guidance.

## Event diff resolution

| Event | Base | Head |
| --- | --- | --- |
| `pull_request` / `pull_request_target` | PR base SHA | PR head SHA |
| `push` | `before` SHA | pushed SHA (`after`) |
| `workflow_dispatch` and anything else | `base-ref` input (required) | `head-ref` input or `HEAD` |

The action never assumes `main` and never assumes the default branch exists
locally. A branch-creating push (`before` is the zero SHA) fails with
instructions to pass `base-ref` explicitly. Explicit `base-ref`/`head-ref`
inputs override every event.

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `mode` | `changed` | `single`, `changed`, or `all` |
| `spec` | — | required when `mode: single`, rejected otherwise |
| `base-ref` / `head-ref` | — | explicit comparison refs |
| `fail-on` | `error` | `error`, `warning`, `never` |
| `strict` | `false` | strict severities for the run |
| `run-verification` | `true` | run trusted commands from `.specbridge/config.json` |
| `report-directory` | `.specbridge/action-reports` | workspace-relative; `..` rejected |
| `annotations` | `true` | file/line annotations |
| `write-step-summary` | `true` | Markdown report into the Step Summary |
| `annotation-limit` | `50` | 0–1000; excess findings are summarized |

Every input is validated; invalid enum values fail with the accepted values
spelled out.

## Outputs

| Output | Content |
| --- | --- |
| `result` | `passed` or `failed` |
| `verification-id` | unique run id |
| `spec-count` | specs verified |
| `error-count` / `warning-count` / `info-count` | diagnostic totals |
| `json-report` / `markdown-report` / `html-report` | workspace-relative report paths |
| `affected-specs` | JSON array string of verified spec names |

## Annotations

Diagnostics with a repository file (and line where available) become
`error` / `warning` / `notice` annotations titled with the rule ID and
carrying the remediation. Errors get the budget first; past the
`annotation-limit`, one summary warning states how many findings were
suppressed — the report artifacts always contain everything. Paths outside
the repository are never annotated.

## Step Summary

A concise Markdown summary: pass/fail, comparison range, per-spec results
table, blocking issues with rule IDs, command outcomes, and report paths.
No raw command output and no environment data ever appear in it.

## Failure behavior

The step fails when the `fail-on` threshold is reached, a policy is invalid,
the comparison cannot be resolved, or a required command fails to start or
times out — always with the reason in the failure message. The action never
modifies tracked project files; its only writes are the reports.
