# Release checklist (v1.x.y)

The gate list a maintainer walks, in order, before tagging a `v1.x.y`
release. Every gate must be green on the release commit itself — not on a
nearby commit, not "with one known flake". If any gate fails, fix it and
start the list again from the top; a release is cheap to redo before the
tag exists and expensive after.

## 1. Full local verification

On the exact commit you intend to tag:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

All green, zero skipped-with-excuses. CI must also be green for this commit
on all three operating systems and both Node lines.

## 2. Contract freeze

```bash
pnpm check:public-contracts
```

The snapshots under `contracts/` must match the source exactly. If this
release intentionally changes a stable contract, the snapshot update and
its CHANGELOG entry must already be in the release commit — a release never
"fixes up" a contract diff on the fly.

## 3. Plugin artifacts

```bash
pnpm build:plugin
pnpm validate:plugin
pnpm verify:plugin-bundle
```

The committed plugin bundle must be reproducible from source (CI diffs it),
the SHA-256 `checksums.json` must validate, and the isolated-bundle
verification must pass.

## 4. Galleries and registries

```bash
pnpm check:builtin-templates
pnpm check:template-gallery
pnpm validate:extension-registry
pnpm check:extension-registry
pnpm check:builtin-registry
pnpm check:extension-gallery
```

Generated artifacts (embedded template packs, gallery tables, registry
indexes) must match their sources with zero drift.

## 5. Smoke

```bash
pnpm smoke
```

The end-to-end CLI smoke suite against the example Kiro workspace passes.

## 6. Package inspection

```bash
npm pack --dry-run
```

Run for every publishable package and **read the file list**. Nothing
ships that should not: no tests, no source maps, no `.kiro`, no
`.specbridge`, no workspace state, no stray local files. The published
file set matches the package `files` allowlist and nothing else.

## 7. Release dry run

The release dry-run workflow is green for the release commit. The dry run
must produce the exact artifacts and checksum manifests a real release
would, without publishing anything.

## 8. Versions consistent

One version everywhere: the root `package.json`, every publishable package,
the plugin manifest, and the CLI's reported `specbridge --version` all
agree on `1.x.y`, and internal compatibility ranges (extension/SDK
`compatibility.specbridge`) still admit it.

## 9. CHANGELOG and release notes

- `CHANGELOG.md` has a complete `1.x.y` section: every user-visible change,
  every contract change, every deprecation.
- Release notes are drafted from it — honest about limitations (unsigned
  binaries, experimental integrations) and free of claims the code does
  not back.

## 10. Tag — and only now

Only after every gate above is green on this exact commit:

- Create the annotated tag `v1.x.y` on that commit and the GitHub Release
  from it, attaching the artifacts and their SHA-256 checksum manifests
  from the dry-run-verified pipeline.

Hard rules, no exceptions:

- **Never overwrite an existing tag or Release.** A bad release gets a new
  patch version; a published tag is immutable history.
- **Never force-push** — not to `main`, not to release branches, not to
  tags.
- No remote operation (push, tag, Release, npm publish) happens without
  explicit authorization for that exact operation.
