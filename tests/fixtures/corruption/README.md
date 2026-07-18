# Corruption fixtures

The v1.0.0 migration/validation/recovery tests deliberately do **not** check
corrupted state files into the repository. Every corruption case is generated
programmatically into a fresh temp directory by
`tests/cli/corruption-helpers.ts`, following the same pattern as
`tests/helpers-templates.ts` (hostile or malformed content never lives in the
tree; tests can freely mutate bytes, inject traversal paths, and write
half-finished JSON without polluting fixtures).

This document is the index of the cases covered and where each is exercised.

## Cases and coverage

| Corruption case | Generator | Covered in |
| --- | --- | --- |
| Truncated JSON (state file cut mid-token) | `truncatedStateJson()` | `tests/cli/state-validate.test.ts` |
| Partially written state (half a JSON object) | inline `write(...)` | `tests/cli/state-validate.test.ts` |
| Invalid JSON (not JSON at all) | inline `write(...)` | `tests/cli/state-validate.test.ts` |
| Unknown schemaVersion (e.g. `"9.0.0"`) | inline `write(...)` | `tests/cli/state-validate.test.ts` |
| Missing schemaVersion (legacy `{"specName": …}` shape) | inline `write(...)` | `tests/cli/state-validate.test.ts` |
| Orphan spec state (state file, no `.kiro/specs/<name>/`) | `testWorkflowState` + `write(...)` | `state-validate`, `state-recover` |
| Missing sidecar (only `.kiro/`) | `kiroWorkspace()` | `tests/cli/state-validate.test.ts` |
| Stale approval (`approvedHash` mismatching file bytes) | `writeStaleSpecState()` | `tests/cli/state-validate.test.ts` |
| Stale/corrupt interactive lock | inline `write(...)`, `writeValidLock()` | `state-validate`, `state-recover` |
| Invalid run record (`run.json` wrong shape) | inline `write(...)` | `tests/cli/state-validate.test.ts` |
| Invalid evidence record (bad JSON and bad shape) | `validEvidenceRecord()` + inline | `state-validate`, `state-recover` |
| Evidence referencing paths outside the repository | `validEvidenceRecord({changedFiles})` | `tests/cli/state-validate.test.ts` |
| Invalid runner profile in config (v2, unknown profile) | inline `write(...)` | `tests/cli/state-validate.test.ts` |
| Forbidden fragment in config (rejected, never migrated) | inline `write(...)` | `tests/cli/migrate.test.ts` |
| Invalid template record line (`template-records.jsonl`) | inline `write(...)` | `tests/cli/state-validate.test.ts` |
| Invalid installed template pack manifest | inline `write(...)` | `tests/cli/state-validate.test.ts` |
| Invalid extension `grants.json` | inline `write(...)` | `tests/cli/state-validate.test.ts` |
| Corrupted registry cache | inline `write(...)` | `state-validate`, `state-recover` |
| Interrupted migration (`plan.json` without `result.json`, with/without backup) | `writeInterruptedMigration()` | `state-validate`, `state-recover`, `migrate` |
| CRLF-only JSON state (must stay valid) | inline `.replace(/\n/g, '\r\n')` | `tests/cli/state-validate.test.ts` |
| UTF-8 BOM state content (readers reject BOM JSON → `invalid` finding) | inline `﻿` prefix | `tests/cli/state-validate.test.ts` |
| Tampered migration plan (hash mismatch refused) | core `buildMigrationPlan` + mutation | `tests/cli/migrate.test.ts` |
| Failed migration (post-write validation) restores originals | core `applyMigrationPlan` + `validateStep` | `tests/cli/migrate.test.ts` |

## Behavior contract exercised against these fixtures

- `specbridge state validate` is strictly read-only (asserted by hashing the
  whole workspace tree before/after) and exits 1 on any non-`valid` finding.
- `specbridge state recover --plan` writes only the plan file; `--apply`
  requires the printed acknowledgement token, revalidates every recorded file
  hash, quarantines instead of deleting, and appends every attempt to
  `.specbridge/recovery/log.jsonl`.
- Recovery never proposes actions for the evidence family, never touches
  anything outside `.specbridge/`, and never invents approvals.
- `specbridge migrate apply` is the only migration writer: hash-bound plans,
  byte-identical backups, atomic writes, rollback on failure, idempotent
  re-runs, and a persisted report verified by `specbridge migrate verify`.
