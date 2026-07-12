# Verification policy

A verification policy tunes `spec verify` for one spec. It is plain,
versioned configuration under:

```text
.specbridge/policies/<spec-name>.json
```

A policy is **not** a spec stage: it needs no approval, and `spec policy
init` never approves anything. Verification works without any policy file —
secure built-in defaults apply.

## Schema (1.0.0)

```json
{
  "schemaVersion": "1.0.0",
  "specName": "notification-preferences",
  "mode": "advisory",
  "impactAreas": [
    "src/notifications/**",
    "tests/notifications/**"
  ],
  "protectedPaths": [
    "infra/terraform/**"
  ],
  "requiredVerificationCommands": [
    "test",
    "typecheck"
  ],
  "requireVerifiedTaskEvidence": true,
  "requireRequirementTaskLinks": false,
  "requireTestEvidence": true,
  "rules": {
    "SBV005": { "enabled": true, "severity": "error" },
    "SBV014": { "enabled": true, "severity": "error" }
  }
}
```

- `mode` — `advisory` (uncertain mapping issues warn; deterministic
  correctness violations still error) or `strict` (outside-impact changes
  fail; SBV005 becomes an error).
- `impactAreas` — glob patterns describing where this spec's implementation
  may land. No declaration means no impact-area constraint.
- `protectedPaths` — additional protected globs on top of the built-ins
  (`.kiro/**`, `.specbridge/state/**`, `.specbridge/config.json`,
  `.git/**`). `.git/**` protection can never be removed or downgraded.
- `requiredVerificationCommands` — names of commands from
  `.specbridge/config.json` that must pass. A policy can only *name*
  configured commands, never define command lines (SBV013 fires when the
  name is not configured).
- `requireVerifiedTaskEvidence` — raises SBV004 to error.
- `requireRequirementTaskLinks` — raises SBV007 to error.
- `requireTestEvidence` — raises SBV017 to error.
- `rules` — per-rule `enabled` / `severity` overrides.

## Glob validation

Patterns are matched with [picomatch](https://github.com/micromatch/picomatch)
(`dot: true`) against workspace-relative POSIX paths. Rejected outright:

- absolute paths (`/etc/**`, `C:/…`)
- `..` traversal segments
- null bytes and backslashes
- syntactically invalid globs
- patterns longer than 512 characters

Symlinks that resolve outside the repository are flagged during comparison
and never followed for content.

## Precedence

1. secure built-in defaults (protected paths above)
2. global project configuration (`.specbridge/config.json` —
   `execution.protectedPaths`, `verification.commands`)
3. the per-spec policy file
4. explicit CLI flags — `--strict` tightens the mode for the run and never
   loosens anything; it does not rewrite the policy file

An invalid policy file is fail-closed: verification reports SBV020, runs
with defaults, and exits 2.

## Commands

```sh
specbridge spec policy init <name> [--mode advisory|strict] [--dry-run] [--json]
specbridge spec policy show <name> [--json]
specbridge spec policy validate <name> [--json]
```

`policy init` proposes impact areas from explicit `design.md` path
references and recorded task evidence. The proposals are **hints for
review**, never authoritative facts, and `init` never overwrites an existing
policy. `validate` exits 0 when valid, 1 when invalid (including required
command names that are not configured), and 2 when no policy file exists.
