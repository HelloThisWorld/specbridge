# Spec drift verification

Spec drift is the gap between what an approved spec says and what the
repository does. `specbridge spec verify` measures that gap
**deterministically**: plain data comparisons over the spec documents, the
sidecar approval state, the git comparison, recorded task evidence, and the
exit codes of trusted commands. No model is involved, no network access
happens, and results are reproducible byte for byte.

```text
approved .kiro specs
        +
git diff / working tree / staged changes
        +
task execution evidence
        +
trusted verification commands
        +
spec verification policy
        ↓
deterministic drift diagnostics (SBV001–SBV025)
        ↓
terminal / JSON / Markdown / HTML reports
        ↓
local quality gate or GitHub Action result
```

## What deterministic verification can and cannot prove

It **can** detect, with certainty:

- approval drift: approved documents whose bytes changed (SBV002/SBV003)
- checked tasks without valid, fresh evidence (SBV004, SBV011, SBV015)
- explicit traceability gaps: unreferenced requirements, unlinked tasks,
  references to requirements that do not exist (SBV007–SBV009)
- changes outside declared impact areas and protected-path modifications
  (SBV005, SBV006, SBV014)
- failed, missing, or timed-out trusted verification commands
  (SBV012, SBV013, SBV025)

It **cannot** prove that code semantically implements a natural-language
requirement. SpecBridge never claims that. Findings based on pattern
recognition (test-required language, keyword references, chore-task
exclusion) are labelled `heuristic` and never default to error severity.

## Commands

```sh
specbridge spec verify <name>                 # one spec (working tree default)
specbridge spec verify --changed              # specs affected by the comparison
specbridge spec verify --all                  # every spec
specbridge spec affected                      # mapping only, no rules run
```

Comparison modes (mutually exclusive; default `--working-tree`):

```sh
--diff origin/main...HEAD     # revision range (also base..head)
--base <ref> [--head <ref>]   # explicit endpoints
--working-tree                # staged + unstaged + untracked vs HEAD
--staged                      # staged changes vs HEAD
```

Options: `--run-verification` / `--no-run-verification`, `--policy <path>`,
`--fail-on error|warning|never` (default `error`), `--strict`, `--json`,
`--format terminal|json|markdown|html`, `--output <path>`, `--verbose`.

`--strict` applies strict-mode rule severities for this run without touching
the stored policy files.

Nested workspaces are supported: diffs run with `--relative`, so a `.kiro`
workspace inside a larger repository is compared within its own subtree.

## Read-only guarantee

`spec verify`, `spec affected`, `spec policy show|validate`, and
`verify rules|explain` never modify spec content, approval state, task
checkboxes, or evidence. The only writes are:

- report artifacts under `.specbridge/reports/<verification-id>/` (command
  logs plus `report.json`) — created only when trusted commands execute
- the `--output` file you asked for
- policy files created by the explicit `spec policy init`

A verification run with no command execution and no `--output` writes
nothing at all; tests assert this.

## Reports

- **terminal** — concise, glyph-based (`✓ ! ✗ ·`), honors `NO_COLOR`
- **json** — versioned schema (`schemaVersion 1.0.0`), validated with Zod
  before it is written; diagnostics sorted deterministically
- **markdown** — ready for GitHub Step Summaries and PR comments
- **html** — one portable file: no scripts, no external requests, CSS-only
  severity/spec filters, safe escaping throughout

## Verification commands

Trusted commands come only from `verification.commands` in
`.specbridge/config.json` (argv arrays; shell strings are rejected). Spec
policies may *require* configured commands by name — they can never
introduce a new command line. Defaults:

- locally, only policy-required commands run; `--run-verification` runs
  everything configured; `--no-run-verification` runs nothing and reuses a
  passing result only from valid, fresh evidence recorded at the exact
  current HEAD (the report labels reuse explicitly)
- the GitHub Action runs commands by default (`run-verification: true`)

## Related documents

- [verification-rules.md](verification-rules.md) — all rule IDs
- [verification-policy.md](verification-policy.md) — per-spec policies
- [requirement-task-traceability.md](requirement-task-traceability.md)
- [evidence-freshness.md](evidence-freshness.md)
- [affected-spec-detection.md](affected-spec-detection.md)
- [github-action.md](github-action.md) and [ci-quality-gates.md](ci-quality-gates.md)
