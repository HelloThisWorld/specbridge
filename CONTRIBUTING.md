# Contributing to SpecBridge

Thank you for contributing. SpecBridge guards other people's `.kiro` files
for a living, so the bar for correctness, determinism, and honesty is
deliberately high — the checks below exist to keep it there.

## Development setup

Requirements: **Node >= 20** and **pnpm 9** (the exact version is pinned in
the `packageManager` field of `package.json`).

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

## Checks to run before a PR

```bash
pnpm lint        # eslint over the whole repository
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest (compat fixtures, round-trip byte identity, CLI, drift, ...)
pnpm smoke       # CLI smoke test against the example Kiro workspace
```

CI runs all of these on Linux, macOS, and Windows with Node 20 and 22 —
Windows path handling is a first-class concern, not an afterthought.

## Contract freeze rules (1.x)

Stable public contracts are snapshotted under `contracts/` and checked by:

```bash
pnpm check:public-contracts
```

A failing check means you changed a frozen contract. That is sometimes the
point — but never silently:

1. An **intentional** contract change must update the snapshot under
   `contracts/` in the same PR, **and**
2. add a CHANGELOG entry describing the change and its compatibility
   impact.

A contract-check diff with no snapshot update and no CHANGELOG entry will
not be merged. `docs/stability/public-contracts.md` inventories what is
frozen and at what level.

### Changing schemas

For any persisted or public schema (config, sidecar state, evidence,
policies, manifests, reports):

- **Never remove or rename required fields in 1.x.**
- **Add optional fields only**; readers must keep validating documents
  written by older 1.x versions.
- Update `docs/stability/public-contracts.md` and the contract snapshots,
  and describe the addition in the CHANGELOG.

### Adding a verification rule

Verification rule IDs (`SBVxxx`) are stable and **never renumbered**;
removing a rule leaves a documented gap rather than shifting IDs.

- Add the new rule with the next unused ID at the end of the sequence.
- Update the contract snapshot and `docs/verification-rules.md`.
- Give it a default severity and a confidence class (deterministic or
  heuristic), and cover it with tests.

## Adding a template

Built-in template packs are data (JSON manifest + Markdown), live under
`packages/templates/builtins/<id>/`, and are covered by an automatic test
suite. Follow
[docs/template-contribution-guide.md](docs/template-contribution-guide.md),
and remember the generated artifacts:

```bash
pnpm generate:builtin-templates
pnpm generate:template-gallery
```

CI fails on drift between the packs on disk and the generated module or
gallery.

## Adding an extension

Community extensions do not live in this repository — the registry lists
metadata only. See
[registry/CONTRIBUTING.md](registry/CONTRIBUTING.md) for the entry
requirements (extension ID grammar, HTTPS archive URL, exact archive
SHA-256, permissions matching the manifest byte-for-byte), then:

```bash
pnpm generate:extension-registry
pnpm validate:extension-registry
```

Understating permissions in a registry entry is grounds for removal.
Listing is not endorsement.

## Commit conventions

Look at `git log` for the house style. In practice:

- **Imperative subject lines** ("Add …", "Redact …", "Verify …"), no
  trailing period.
- Focused changes use a scoped conventional prefix:
  `feat(templates): add reusable spec template system`.
- Keep a commit to one logical change; explain *why* in the body when the
  subject cannot carry it.

## PR checklist

- [ ] `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass locally
- [ ] `pnpm check:public-contracts` passes — or the snapshot is
      intentionally updated **and** the CHANGELOG explains the contract
      change
- [ ] Documentation updated for any user-visible behavior
- [ ] CHANGELOG entry added for any user-visible change
- [ ] Everything is in English (code, comments, docs, commit messages)
- [ ] No employer or client proprietary content — synthetic examples only
- [ ] No credentials, tokens, or secret values anywhere in the diff,
      fixtures, or test output

## Security expectations

Read [SECURITY.md](SECURITY.md) and the
[threat model](docs/security/threat-model.md) before touching anything
security-relevant. Ground rules that PRs must not erode:

- Untrusted content (specs, source, model output, templates, extensions)
  is data, never instructions.
- Every write goes through the workspace guard and stays atomic.
- Model claims are never evidence; permission bypass flags are never
  passed; nothing commits, pushes, resets, or rolls back automatically.

If you find a vulnerability while contributing, report it privately per
SECURITY.md instead of describing it in a public PR.
