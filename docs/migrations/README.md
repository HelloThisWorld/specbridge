# Migrations & recovery

How SpecBridge state moves between versions, and how damaged state is
repaired. One philosophy governs all of it:

**Nothing migrates automatically.** Ordinary commands only detect and
report: reading old state never rewrites it, and no command upgrades a file
as a side effect. Every write below is an explicit command you run, is
atomic, takes a backup, and rolls back on failure.

Your `.kiro` directory is not part of any of this — migrations and
recovery touch only SpecBridge's own sidecar state under `.specbridge/`.

## The migration commands

```bash
specbridge migrate status   # read-only: schema versions per state family
specbridge migrate plan     # read-only: the exact steps a migration would take
specbridge migrate apply    # the single writer — hash-bound plan, backups, report
specbridge migrate verify   # re-check a persisted migration report against the workspace
```

- `migrate status` and `migrate plan` are pure reads over the eight state
  families (config, spec-state, runs, evidence, policies, templates,
  extensions, registries).
- `migrate apply` executes the plan it just built: atomic writes,
  recoverable backups, rollback on failure, and a persisted migration
  report. `--dry-run` previews without writing.
- `migrate verify` re-checks a persisted report against the current
  workspace.

Honesty note: the only migration that has ever existed is the
configuration v1 → v2 rewrite (details:
[configuration migration](../configuration-migration.md)). Every other
persisted schema has been at 1.0.0 since its introduction, so for most
workspaces `migrate status` reports nothing to do — that is the expected
result. The older `specbridge config migrate` remains as a deprecated
alias for the same config migration (removal no earlier than v2.0.0).

## Validating state

```bash
specbridge state validate            # scan every family (read-only)
specbridge state validate --spec <name> --json
```

`state validate` never writes. It scans one family or all of them
(`--config`, `--spec <name>`, `--runs`, `--evidence`, `--templates`,
`--extensions`, `--registries`) and reports invalid or damaged records.

## Recovering damaged state

Recovery is a two-step, hash-bound flow — the apply step can only execute
the exact plan you previewed:

```bash
specbridge state recover --plan
# persists a recovery plan and prints its acknowledgement token; writes
# nothing else

specbridge state recover --apply <planId> --ack <token>
# executes that plan: backups first, damaged records quarantined rather
# than destroyed, failures roll every move back, outcome appended
```

A wrong or stale acknowledgement token, or an unknown plan ID, fails
honestly — there is no force flag.

For a read-only preview during diagnosis, `specbridge doctor
--repair-plan` additionally shows the recovery actions `state recover
--plan` would persist, without persisting anything.

## Version upgrade guides

- [v1.0.0 migration guide](migration-guide-v1.0.0.md) — upgrading from any
  0.x release to 1.0.0.
- [Configuration migration (v1 → v2)](../configuration-migration.md) —
  the config schema rewrite introduced in v0.6.
- [Migration from Kiro](../migration-from-kiro.md) — there is none; that
  page exists to say so.
