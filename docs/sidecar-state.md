# Sidecar state (`.specbridge/`)

`.kiro` holds the human-readable, Kiro-compatible truth. Everything
SpecBridge needs beyond that — workflow mode, approvals, run records,
evidence — lives in a separate sidecar directory. This is the data-ownership
rule that makes the zero-migration promise durable: uninstall SpecBridge,
delete `.specbridge/`, and your Kiro project is exactly as it was.

## Layout

```
.specbridge/
├── config.json                  # runner configuration (no secrets, ever)
├── state/
│   └── specs/
│       └── <spec-name>.json     # workflow mode, stage approvals, hashes
├── tmp/                         # spec-creation staging (removed after use)
├── runs/                        # per-run records (Phase G)
├── evidence/
│   └── <spec-name>/<task>.json  # task evidence records (Phase G/H)
├── reports/                     # generated reports (drift, context --out)
└── cache/                       # disposable
```

Only `config.json`, `state/`, and the transient `tmp/` exist in v0.2
workflows; the rest is created by later-phase commands. Nothing here is
required — a workspace without `.specbridge/` is fully supported.

## Spec state schema (1.0.0)

`.specbridge/state/specs/<name>.json` is versioned and validated with zod;
unknown fields written by newer 1.x versions survive a read-modify-write.

```json
{
  "schemaVersion": "1.0.0",
  "specName": "notification-preferences",
  "specType": "feature",
  "workflowMode": "requirements-first",
  "origin": "created-by-specbridge",
  "status": "DESIGN_DRAFT",
  "createdAt": "2026-07-01T09:00:00.000Z",
  "updatedAt": "2026-07-01T10:00:00.000Z",
  "stages": {
    "requirements": {
      "status": "approved",
      "file": ".kiro/specs/notification-preferences/requirements.md",
      "approvedAt": "2026-07-01T10:00:00.000Z",
      "approvedHash": "a8571bce929fcce33ddf4ff6292e712a3efe1b267c4285cfabe0758d4c607317"
    },
    "design": {
      "status": "draft",
      "file": ".kiro/specs/notification-preferences/design.md",
      "approvedAt": null,
      "approvedHash": null
    },
    "tasks": {
      "status": "blocked",
      "file": ".kiro/specs/notification-preferences/tasks.md",
      "approvedAt": null,
      "approvedHash": null
    }
  }
}
```

- `workflowMode`: `requirements-first` | `design-first` | `quick`. The file
  layout cannot express this; without sidecar state SpecBridge reports
  `unknown`.
- `origin`: `created-by-specbridge`, or `existing-kiro-workspace` when the
  state was initialized by the first approval of a pre-existing Kiro spec.
- `status`: the workflow status derived from stage approvals — see
  [approval-workflow.md](approval-workflow.md) for the per-mode state
  machines.
- `stages`: one entry per approvable stage, in workflow order. Bugfix specs
  replace `requirements` with `bugfix`. `approvedHash` is the SHA-256 of the
  exact approved file bytes; `blocked`/`draft` stages carry nulls. Approval
  is only ever read from here — never inferred from file existence.
- Stage `file` paths are workspace-relative with forward slashes and are
  guarded against traversal when resolved.

Invalid, legacy (pre-1.0.0), or corrupt state files degrade to warnings and
the spec is treated as unmanaged; the `.kiro` files always win. Read-only
commands never rewrite state — stale approvals are recomputed in memory and
repaired only by an explicit re-approval.

## Evidence records

`.specbridge/evidence/<spec>/<task>.json` (Phase G/H):

```json
{
  "taskId": "2.3",
  "status": "verified",
  "changedFiles": ["src/notifications/NotificationPreferencesService.ts"],
  "commands": [{ "command": "npm test", "exitCode": 0 }],
  "verifiedAt": "2026-07-03T12:00:00Z"
}
```

A task checkbox is only ever marked complete after evidence exists — never
because an agent replied "done".

## Rules

1. Never write SpecBridge metadata into `.kiro` files (doctor actively scans
   for violations).
2. All writes are atomic (temp file + rename) and path-checked against
   traversal outside the workspace.
3. Sidecar files are plain JSON with stable formatting — meant to be
   committed if your team wants shared approvals, or gitignored if not.
4. No secrets: runner configs reference commands, not keys.

## What to commit

Committing `config.json` and `state/` shares workflow status across the
team. `runs/`, `cache/`, and `reports/` are typically gitignored. This
repository's examples commit state files on purpose, to demonstrate the
format.
