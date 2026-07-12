# Spec drift verification (moved)

The v0.1 design notes that lived here became reality in v0.4. The canonical
documentation is now:

- [spec-drift-verification.md](spec-drift-verification.md) — concepts,
  commands, comparison modes, read-only guarantee, report formats
- [verification-rules.md](verification-rules.md) — the stable rule IDs
  SBV001–SBV025
- [verification-policy.md](verification-policy.md) — per-spec policies
- [evidence-freshness.md](evidence-freshness.md) — evidence validation and
  the normalized task-plan approval hash
- [affected-spec-detection.md](affected-spec-detection.md) — `--changed`
  resolution
- [github-action.md](github-action.md) and
  [ci-quality-gates.md](ci-quality-gates.md) — CI integration

The v0.1 library primitives (`parseNameStatus`, `evaluateImpactAreas`,
`assessRequirementCoverage`, `assessTaskCoverage`, `buildDriftReport`)
remain exported from `@specbridge/drift` unchanged.
