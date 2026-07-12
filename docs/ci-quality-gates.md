# CI quality gates

How to gate merges on deterministic spec verification — locally, in any CI
system, or with the bundled GitHub Action.

## Exit-code contract (`spec verify`)

| Code | Meaning | Typical CI reaction |
| --- | --- | --- |
| 0 | passed according to `--fail-on` | continue |
| 1 | diagnostics reached the failure threshold | fail the job |
| 2 | invalid input, invalid policy (SBV020), invalid state | fail and fix configuration |
| 3 | git comparison unavailable (SBV021) | fetch history (`fetch-depth: 0`) |
| 4 | required verification command failed to start | fix the command/tooling |
| 5 | required verification command timed out or was cancelled | raise the timeout or speed the command up |

Codes 0–2 keep their v0.1 meanings; 3–5 refine the v0.3 runner codes for
verification. Other SpecBridge commands keep their documented contracts.

## Thresholds

`--fail-on error` (default) fails on errors only. `--fail-on warning` also
fails on warnings — useful for keeping traceability tight. `--fail-on never`
always exits 0/2/3/4/5 (setup problems still fail) and is meant for
report-only jobs.

`--strict` applies strict-mode severities (e.g. SBV005 becomes an error)
without editing any policy file; per-spec `mode: strict` makes that
permanent in review-able configuration.

## Generic CI (any provider)

```sh
specbridge spec verify --changed \
  --diff "$BASE_SHA...$HEAD_SHA" \
  --run-verification \
  --format markdown --output verification.md
```

Publish `verification.md` (and `--format html` / `--json` variants) as build
artifacts. JSON reports validate against a versioned schema
(`schemaVersion 1.0.0`), so downstream tooling can consume them stably.

## Local pre-push gate

```sh
specbridge spec verify --changed --diff origin/main...HEAD
specbridge spec verify <spec> --working-tree      # while iterating
specbridge spec verify <spec> --staged            # what a commit would contain
```

Local runs execute only policy-required commands by default; add
`--run-verification` for the full battery or `--no-run-verification` to
reuse fresh evidence recorded at the current HEAD.

## GitHub Action

See [github-action.md](github-action.md) — same engine, event-based diff
resolution, Step Summary, bounded annotations, and report artifacts.

## What a green gate means — and does not mean

Green means: approvals match the current documents, checked tasks carry
valid fresh evidence, explicit traceability is intact, changes stay inside
declared impact areas, protected paths are untouched, and the trusted
commands passed. It does **not** mean the implementation semantically
satisfies every requirement — SpecBridge never claims that.
