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
│       └── <spec-name>.json     # workflow, status, approvals, impact areas
├── runs/                        # per-run records (Phase G)
├── evidence/
│   └── <spec-name>/<task>.json  # task evidence records (Phase G/H)
├── reports/                     # generated reports (drift, context --out)
└── cache/                       # disposable
```

Only `config.json` and `state/` exist in v0.1 workflows; the rest is created
by later-phase commands. Nothing here is required — a workspace without
`.specbridge/` is fully supported.

## Spec state schema

`.specbridge/state/specs/<name>.json` (validated with zod, unknown fields
preserved for forward compatibility):

```json
{
  "specName": "notification-preferences",
  "specType": "feature",
  "workflowMode": "requirements-first",
  "status": "DESIGN_APPROVED",
  "approvals": {
    "requirements": { "approved": true, "approvedAt": "2026-07-01T10:00:00Z" },
    "design": { "approved": true, "approvedAt": "2026-07-02T09:30:00Z" }
  },
  "declaredImpactAreas": ["src/notifications/**", "tests/notifications/**"],
  "verificationCommands": ["npm test"]
}
```

- `workflowMode`: `requirements-first` | `design-first` | `quick`. The file
  layout cannot express this; without sidecar state SpecBridge reports
  `unknown`.
- `status`: `DRAFT` → `REQUIREMENTS_APPROVED` → `DESIGN_APPROVED` →
  `READY_FOR_EXECUTION` → `IN_PROGRESS` → `COMPLETE`.
- `declaredImpactAreas` / `verificationCommands`: consumed by drift
  verification (Phase H). Verification commands come from this trusted file
  or explicit user input — never from model output.

Invalid or corrupt state files degrade to warnings; the `.kiro` files always
win.

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
