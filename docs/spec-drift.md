# Spec drift verification

Spec drift is the gap between what the spec says and what the code does.
SpecBridge's drift verifier is **deterministic** — plain data comparisons
over the spec, the git diff, and recorded evidence. No LLM is involved, so
results are reproducible and CI-safe.

## Status

| Piece | Status |
| --- | --- |
| Deterministic primitives (`@specbridge/drift`) | ✅ Implemented and tested in v0.1 |
| `specbridge spec verify` CLI + git wiring | 🚧 Phase H |
| Terminal / JSON / HTML drift reports | 🚧 Phase H (HTML renderer already exists in `@specbridge/reporting`) |
| GitHub Action drift gate | 🚧 Phase I |

The primitives shipping today: `parseNameStatus` / `collectChangedFiles`
(git diffs), `evaluateImpactAreas` (glob-based impact areas),
`assessRequirementCoverage`, `assessTaskCoverage`, evidence storage, and
`buildDriftReport` / `driftExitCode`. See `tests/drift/` for executable
specifications.

## Planned CLI

```sh
specbridge spec verify <name> --diff origin/main...HEAD
specbridge spec verify --changed          # specs affected by the current diff
specbridge spec verify --all
specbridge spec verify <name> --working-tree
```

Exit codes: `0` passed · `1` drift or quality-gate failure · `2` invalid
configuration or runtime error.

## Checks

Inputs: requirements/bugfix + design + tasks documents, sidecar metadata
(`declaredImpactAreas`, `verificationCommands`), the git diff, and task
evidence. Detections, by category:

1. Tasks marked complete without evidence (`task-evidence`, fail)
2. Required tests with no test evidence (`test-evidence`, fail)
3. Changed files outside declared impact areas (`impact-area`, fail)
4. Acceptance criteria no task references (`requirement-coverage`, warn)
5. Tasks not linked to requirements where linking is in use (`task-linking`, info)
6. Required files missing (`required-files`)
7. Invalid or inconsistent checkbox state (`checkbox-state`)
8. Spec changed after implementation without re-verification
9. Design-declared components with no implementation evidence
10. Failed verification commands (`verification-command`, fail)

Checks 1–5 and 7 exist as library functions today; 6 and 8–10 are designed
but not yet implemented anywhere (they are listed here for the record, not
claimed).

## Report shape

```
Spec Drift Report

Spec: notification-preferences
Diff: origin/main...HEAD

Requirements:
✓ 1.1 referenced by task 1
✗ 2.1 has no test evidence

Impact areas:
✗ src/billing/BillingService.ts changed outside declared impact areas

Tasks:
✓ 6 verified
! 2 implemented but unverified
✗ 1 marked complete without evidence

Result: FAILED
```

The same data will be emitted as JSON (`specbridge.drift/1` envelope) and as
a self-contained HTML file under `.specbridge/reports/`.

## Why deterministic first

A quality gate that can hallucinate is worse than no gate. The MVP verifier
only asserts things it can prove from files, diffs, and exit codes. A future
optional LLM layer may *explain* drift, but will never decide pass/fail.
