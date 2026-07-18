# Example: CI drift gate

A workspace wired up as a pull-request quality gate: one fully approved
spec, a committed verification policy, a trusted verification command, and
an example GitHub Actions workflow. Everything verification does here is
deterministic — file bytes, hashes, git diffs, and exit codes. No model, no
API key, no network.

Contents:

- `.kiro/specs/audit-log-export/` — approved requirements, design, tasks
- `.specbridge/state/specs/audit-log-export.json` — sidecar state, all
  three stages approved (SHA-256 over the exact file bytes; the task plan
  additionally records checkbox-tolerant hash semantics v2)
- `.specbridge/policies/audit-log-export.json` — the verification policy
- `.specbridge/config.json` — defines the trusted `audit-tests` command
- `src/audit/`, `tests/audit/` — the implementation area the policy maps
- `db/migrations/` — a protected path
- `.github/workflows/spec-verify.yml` — **example** workflow to copy into
  your own repository (not an active workflow here)

## The policy

`.specbridge/policies/audit-log-export.json` is plain versioned JSON —
never executable, never a spec stage, and optional (verification falls back
to secure defaults without it):

- `mode: strict` — changes outside declared impact areas become errors
  (SBV005) instead of warnings
- `impactAreas` — where this spec's implementation may land
  (`src/audit/**`, `tests/audit/**`)
- `protectedPaths` — `db/migrations/**` on top of the built-ins
  (`.kiro/**`, `.specbridge/state/**`, `.specbridge/config.json`, and the
  never-removable `.git/**`)
- `requiredVerificationCommands: ["audit-tests"]` — a policy may only
  *name* commands defined in `.specbridge/config.json` (argv arrays, never
  shell strings); it can never introduce a command line of its own
- `requireVerifiedTaskEvidence` / `requireRequirementTaskLinks` — raise
  the matching rules to errors
- `rules` — per-rule overrides (here SBV018 is raised to error)

See [docs/verification-policy.md](../../docs/verification-policy.md).

## Run the gate locally

From the repository root (after `pnpm install && pnpm build`):

```sh
cd examples/ci-drift-gate
node ../../packages/cli/dist/index.js spec policy validate audit-log-export
node ../../packages/cli/dist/index.js spec verify audit-log-export --working-tree
```

Expected summary — the committed workspace is aligned, and the trusted
command runs and passes:

```text
Policy: strict (.specbridge/policies/audit-log-export.json)
Verification commands:
  ✓ audit-tests — exit 0
Result: PASSED — 0 errors, 0 warnings, 0 info
```

Now make it fail. Each of these is caught deterministically:

```sh
echo "drift" >> .kiro/specs/audit-log-export/requirements.md   # SBV002: approved bytes changed
echo "x" > src/billing.mjs                                     # SBV005: outside impactAreas (error in strict mode)
echo "-- tweak" >> db/migrations/001_create_export_log.sql     # SBV006: protected path modified
git checkout -- . && git clean -fd .                           # restore; verify passes again
```

Exit codes are stable (0 pass, 1 findings at the `--fail-on` threshold,
2 invalid policy, 3 git comparison unavailable, 4/5 command failures) — see
[docs/verification-rules.md](../../docs/verification-rules.md).

## The Git diff basis

`spec verify` always compares two states of the repository:

```sh
--working-tree                  # staged + unstaged + untracked vs HEAD (default)
--staged                        # staged changes only
--diff origin/main...HEAD       # a revision range
--base <ref> [--head <ref>]     # explicit endpoints
```

In CI the action resolves the range from the event (PR base/head SHAs for
`pull_request`, `before`/`after` for `push`) and never assumes `main`.
Because the comparison needs history, check out with `fetch-depth: 0`;
without it verification fails honestly with SBV021 instead of guessing.

## Reports

The same engine renders four formats:

```sh
node ../../packages/cli/dist/index.js spec verify audit-log-export --working-tree --json
node ../../packages/cli/dist/index.js spec verify audit-log-export --working-tree --format markdown --output report.md
node ../../packages/cli/dist/index.js spec verify audit-log-export --working-tree --format html --output report.html
```

- **terminal** — the concise glyph output above (`NO_COLOR` honored)
- **json** — versioned schema (`schemaVersion: "1.0.0"`), Zod-validated,
  deterministically sorted; for your own tooling
- **markdown** — what the Action writes into the GitHub Step Summary
- **html** — one portable file, no scripts, no external requests

## The GitHub Action

Copy [.github/workflows/spec-verify.yml](.github/workflows/spec-verify.yml)
into your repository's real `.github/workflows/`. It pins
`HelloThisWorld/specbridge/integrations/github-action@v1` (tag exists once
v1.0.0 is released) and uses the action's actual inputs: `mode`, `spec`,
`base-ref`/`head-ref`, `fail-on`, `strict`, `run-verification`,
`report-directory`, `annotations`, `write-step-summary`,
`annotation-limit`.

On failure, the PR gets:

- a failed check (threshold from `fail-on`)
- **file/line annotations** titled with the rule ID (SBV002, SBV006, ...)
  and carrying the remediation, capped by `annotation-limit` (errors get
  the budget first; a summary line reports anything suppressed)
- a **Step Summary** with the comparison range, a per-spec results table,
  and blocking issues
- JSON/Markdown/HTML report artifacts under `report-directory` (upload
  them with `actions/upload-artifact` as the example workflow does)

See [docs/github-action.md](../../docs/github-action.md) and
[docs/ci-quality-gates.md](../../docs/ci-quality-gates.md).

The passing path (`spec policy validate` + `spec verify`, including the
drift/restore round trip) is exercised offline by
`node scripts/validate-examples.mjs` against a temporary copy of this
directory.
