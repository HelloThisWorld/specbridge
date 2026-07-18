# Migrating to SpecBridge 1.0.0

Audience: anyone running a 0.x release of SpecBridge (any version from
0.1.0 through 0.7.1) who wants to move to 1.0.0. It is honest about how
little most workspaces need to do.

## The short version

- **`.kiro` is untouched.** SpecBridge 1.0.0 reads the same
  `.kiro/steering` and `.kiro/specs` files, in the same locations, in the
  same format, as every 0.x release. There is nothing to convert.
- **Almost every sidecar schema is already at `1.0.0`.** Spec state,
  approvals, run records, evidence, verification policies, template
  records, extension state, and registries have been schema `1.0.0` since
  they were introduced. Upgrading the SpecBridge product version does not
  bump any of them.
- **There is exactly one real migration**: `.specbridge/config.json` v1 →
  v2. It has existed — and been entirely optional — since v0.6. If you
  already ran it, or never had a v1 `config.json`, there is nothing left
  to do.
- **New commands exist to check and repair state**, but none of them run
  automatically and none require action unless something is actually
  wrong.
- **SpecBridge is on npm for the first time**, published as
  `specbridge-cli`. The installed command is `specbridge`.
- **Template and extension authors** should widen their manifest's
  compatibility range.

If you only read one command, read this one:

```bash
specbridge migrate status
```

It is entirely read-only and tells you exactly what (if anything) applies
to your workspace.

## 1. `.kiro` — nothing to do

`specbridge doctor` and `specbridge compat check` still prove this on every
run: every Markdown file under `.kiro` round-trips byte-identically, no
SpecBridge metadata is written into `.kiro`, and no command modifies
`.kiro` as a side effect of upgrading. Zero-migration was the v0.1 promise
and remains the v1.0.0 promise.

## 2. Sidecar state (`.specbridge`) — check, don't assume

Run the read-only status report before doing anything else:

```bash
specbridge migrate status
```

Expected output for the overwhelming majority of 0.x workspaces is a table
where every family shows `0` pending migrations, followed by:

```
Nothing to migrate and nothing invalid.
```

For a deeper, per-file scan across every persisted state family (config,
spec state, runs, evidence, policies, templates, extensions, registries),
use the new:

```bash
specbridge state validate
```

This is also entirely read-only — it degrades bad state to a finding, it
never repairs or deletes anything. See [New in 1.0.0](#4-new-in-100-validate-and-recover-state)
below for what to do if it reports a problem.

## 3. The one migration: configuration v1 → v2

If `migrate status` reports a pending migration for the `config` family
(only possible if your `.specbridge/config.json` still uses the pre-v0.6
schema), preview it and apply it explicitly:

```bash
specbridge migrate plan     # read-only: prints the exact steps, writes nothing
specbridge migrate apply    # writes: backs up the original, then rewrites atomically
```

`migrate apply` copies the original file to a backup before writing
anything, writes the new file atomically, re-reads and validates the
result, and restores the original automatically if anything fails. A full
report is written under `.specbridge/migrations/<planId>/`, which you can
re-check any time with:

```bash
specbridge migrate verify
```

What the v1 → v2 rewrite actually changes — your effective Claude Code
behavior is preserved, and no new provider is enabled — is documented in
full at [Configuration migration (v1 → v2)](../configuration-migration.md).

**The old command still works.** `specbridge config migrate --dry-run` /
`--apply` is now a deprecated alias for the same rewrite. It keeps working
exactly as before; it now also prints this to stderr (never to stdout, so
`--json` output stays clean):

```
Deprecated: "specbridge config migrate" will be removed no earlier than v2.0.0; use "specbridge migrate plan" / "specbridge migrate apply" instead.
```

There is no forced cutover. Switch to `specbridge migrate plan` /
`specbridge migrate apply` whenever convenient; removal of the old alias
will not happen before a 2.0.0 release, and will follow the
[CLI deprecation policy](../stability/versioning-policy.md#cli-deprecation-policy)
(announced first, documented replacement, never removed before the next
major).

## 4. New in 1.0.0: validate and recover state

Three new, entirely optional commands exist for diagnosing and repairing
`.specbridge/` state. None of them run as a side effect of anything else,
and none of them ever touch `.kiro`.

```bash
specbridge state validate                     # read-only: scan every family
specbridge doctor --repair-plan               # read-only: doctor + a recovery preview
specbridge state recover --plan                # writes ONLY a plan file, prints a token
specbridge state recover --apply <planId> --ack <token>   # executes that exact plan
```

Recovery is a deliberate two-step, hash-bound flow: `--plan` persists a
plan and prints an acknowledgement token; `--apply` re-validates every
file's hash against that plan before touching anything, and every action
it performs moves bytes into `.specbridge/quarantine/<planId>/` — nothing
is ever destroyed, and there is no force flag. A stale or wrong token, or
an unknown plan ID, is refused rather than guessed at.

Most 0.x workspaces will never need this. It exists for the case where
`.specbridge/` state was corrupted or partially written (for example, by
a process that was killed mid-write) and gives you an inspectable, safe
way to repair it.

Details: [Migrations & recovery](README.md).

## 5. SpecBridge is on npm for the first time

Earlier 0.x releases were installed from source or the Claude Code plugin
— there was no published npm package, and no prebuilt standalone archive
either (both are new in 1.0.0; see the
[1.0.0 release notes](../releases/v1.0.0.md)). The npm package is named
`specbridge-cli` (the short name `specbridge` on the npm registry belongs
to an unrelated project). The installed command is `specbridge`:

```bash
npm install -g specbridge-cli
specbridge --version
```

This does not replace or conflict with any 0.x installation method you
were already using — a from-source checkout or the Claude Code plugin
continue to work exactly as before. The npm package (and the standalone
archives) are simply new, additional ways to install the same CLI.

```bash
npx -p specbridge-cli specbridge doctor   # one-off use without a global install
```

## 6. Template and extension authors: widen your compatibility range

Every template manifest (`specbridge-template.json`) and extension
manifest (`specbridge-extension.json`) declares the product versions it
supports in `compatibility.specbridge`, using a small semver-range syntax
(space-separated `>=`, `<=`, `>`, `<`, `=` comparisons — no `^`, `~`, or
`||`). If your manifest currently reads:

```json
"compatibility": {
  "specbridge": ">=0.7.0 <1.0.0"
}
```

widen the upper bound so 1.0.0 (and every 1.x release) is accepted:

```json
"compatibility": {
  "specbridge": ">=0.7.0 <2.0.0"
}
```

This is exactly the change made to every built-in template and reference
extension in this repository for the 1.0.0 release. `<2.0.0` is the right
upper bound under the [versioning policy](../stability/versioning-policy.md):
nothing that is documented and stable today can break within the v1.x
line, so any 1.x release stays compatible; a 2.0.0 release is exactly the
kind of change that would warrant re-reviewing compatibility anyway.

Extension manifests that also declare `compatibility.extensionSdk` should
widen that the same way if the extension SDK version they depend on
followed the same `<1.0.0` → `<2.0.0` change.

Validate the result before publishing:

```bash
specbridge template validate <path>       # template authors
specbridge extension validate <path>      # extension authors
```

## If something does not match this guide

`specbridge migrate status` and `specbridge state validate` are read-only
and safe to run at any time, on any workspace, in any state. If either
reports something this guide does not explain, or a repair does not
resolve it, please open an issue with their `--json` output attached:
<https://github.com/HelloThisWorld/specbridge/issues>.
