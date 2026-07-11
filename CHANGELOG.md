# Changelog

## 0.2.0

- Offline Kiro-compatible spec creation: `spec new` renders plain-Markdown
  templates for feature and bugfix specs — no model, no API key, no network.
- Requirements-first, design-first, quick, and bugfix workflows with an
  explicit state machine and per-stage approval gates.
- Deterministic spec analysis: `spec analyze` reports structural and
  consistency problems (placeholders, missing criteria, malformed EARS,
  vague wording, task-plan gaps) with error/warning/info levels and
  `--strict` mode. Same bytes, same findings, every time.
- Approval state and document hashing: `spec approve` records the SHA-256 of
  the exact approved file bytes in versioned sidecar state
  (`.specbridge/state/specs/<name>.json`, schema 1.0.0). Approved Markdown
  files are never rewritten.
- Stale approval detection: `spec status`, `spec list`, and `doctor` report
  approved files that changed after approval and invalidate dependent
  approvals in memory; re-approving repairs the hash and cascades honestly.
- Approval revocation: `spec approve --revoke` clears a stage and every
  approval that depended on it, keeping all files.
- Existing Kiro workspace support: specs without SpecBridge state stay fully
  usable (reported as `unmanaged`); the first successful approval initializes
  sidecar state with `origin: existing-kiro-workspace`.
- `spec status` (new), plus extended `spec list` (mode/status/approval
  health), `spec show` (`--state`, `--analysis`, `--status`), and `doctor`
  (sidecar validation, orphan and stale state detection).
- No model or API key required for any v0.2 command; `.kiro` files carry no
  SpecBridge metadata and the byte-identical no-op round trip is unchanged.

## 0.1.0

- Read-only Kiro compatibility: workspace detection, steering discovery,
  spec discovery and classification, tolerant Markdown parsers.
- `doctor`, `steering list/show`, `spec list/show/context`, `compat check`.
- Line-preserving document model with a byte-identical no-op round-trip
  guarantee and a surgical checkbox patcher.
- Deterministic drift-check library primitives, runner interfaces with an
  offline mock runner, terminal/JSON/HTML report helpers.
