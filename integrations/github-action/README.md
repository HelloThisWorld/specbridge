# SpecBridge GitHub Action

Deterministic spec drift verification for Kiro-style specs on every pull
request or push:

- approval drift (`SBV002`, `SBV003`) and stale/missing task evidence
  (`SBV004`, `SBV011`, `SBV015`)
- requirement-to-task traceability gaps (`SBV007`–`SBV010`)
- changes outside declared impact areas and protected-path modifications
  (`SBV005`, `SBV006`, `SBV014`)
- trusted verification commands from `.specbridge/config.json`
  (`SBV012`, `SBV013`, `SBV025`)

**No model, no API key, no Claude installation, no network access.** The
action is a bundled node20 wrapper around the same `@specbridge/drift`
engine the CLI uses — no rule logic is reimplemented here. It never modifies
tracked project files; its only writes are the generated reports.

## Usage

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
          # Full history: the action never fetches by itself, and the diff
          # base of a PR usually lies outside a shallow clone.
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

## Diff resolution per event

| Event | Base | Head |
| --- | --- | --- |
| `pull_request` / `pull_request_target` | PR base SHA | PR head SHA |
| `push` | `before` SHA | pushed SHA |
| `workflow_dispatch` and others | `base-ref` input (required) | `head-ref` input or `HEAD` |

The action never assumes `main`, never assumes the default branch exists
locally, and never fetches. When history is missing (shallow clone), the run
fails with `SBV021` and the `fetch-depth: 0` guidance above.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `mode` | `changed` | `single`, `changed`, or `all` |
| `spec` | — | Spec name; required when `mode: single` |
| `base-ref` / `head-ref` | — | Explicit comparison refs (override the event) |
| `fail-on` | `error` | `error`, `warning`, or `never` |
| `strict` | `false` | Strict verification behavior (tightens policies) |
| `run-verification` | `true` | Run trusted commands from `.specbridge/config.json` |
| `report-directory` | `.specbridge/action-reports` | Where reports are written |
| `annotations` | `true` | Emit file/line annotations |
| `write-step-summary` | `true` | Write the Markdown report to the Step Summary |
| `annotation-limit` | `50` | Maximum annotations (0–1000); the rest is summarized |

## Outputs

`result`, `verification-id`, `spec-count`, `error-count`, `warning-count`,
`info-count`, `json-report`, `markdown-report`, `html-report` (paths relative
to the workspace), and `affected-specs` (a JSON array string).

## Exit behavior

The step fails when the `fail-on` threshold is reached, when a policy is
invalid, when the git comparison cannot be resolved, or when a required
verification command fails to start or times out. The Step Summary and the
report artifacts always explain why.

## Building (maintainers)

`dist/index.js` is a committed, reproducible bundle:

```sh
pnpm --filter specbridge-github-action build
git diff --exit-code integrations/github-action/dist
```

CI rebuilds the bundle and fails when the committed file drifts from the
source.
