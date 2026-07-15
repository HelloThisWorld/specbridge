# Template contribution guide

How to contribute a built-in template to this repository. Contributors
never need to write TypeScript: a built-in template is pack files —
JSON and Markdown — plus a passing test suite. Start with
[creating templates](creating-templates.md) for the authoring workflow;
this page covers what is specific to built-ins.

## Where built-ins live

Each built-in pack is a directory under
`packages/templates/builtins/<id>/`:

```
packages/templates/builtins/rest-api/
├── specbridge-template.json
├── README.md
└── files/
    ├── requirements.md.template
    ├── design.md.template
    └── tasks.md.template
```

The directory name must equal the manifest `id`.

## Source of truth and generated artifacts

The packs on disk are the single source of truth. Two artifacts are
generated from them and committed:

- `packages/templates/src/builtin-packs.generated.ts` — the packs
  embedded as string constants so every bundle (CLI, MCP standalone,
  Claude Code plugin) ships the catalog without runtime filesystem
  lookups. Regenerate with `pnpm generate:builtin-templates`.
- The gallery table in [docs/templates.md](templates.md). Regenerate
  with `pnpm generate:template-gallery`.

Never edit either by hand. After changing any pack file:

```bash
pnpm generate:builtin-templates
pnpm generate:template-gallery
```

CI runs `pnpm check:builtin-templates` and `pnpm check:template-gallery`
and fails on drift. The generator also rejects symlinks, non-UTF-8
content, and CRLF line endings in built-in packs.

## The test gate

```bash
npx vitest run tests/templates/builtin-packs.test.ts
```

This suite discovers every directory under `packages/templates/builtins/`
automatically — adding a pack adds its tests. Per pack it checks:

1. **Manifest, README, and declared files are valid** — full pack
   validation with README required, the directory name matching the
   manifest ID, the license being `MIT`, and the compatibility range
   being exactly `>=0.7.0 <1.0.0`.
2. **Render check is clean** — every file renders with deterministic
   sample values and a fixed clock, with zero error-severity issues.
3. **End-to-end apply passes spec analysis** — the template is applied
   into a fresh Kiro workspace; the resulting spec must analyze with no
   error diagnostics, classify as `complete`, and every stage must pass
   stage-level analysis.
4. **No vendor lock-in, employer terms, or absolute paths** — pack
   content must not contain Windows drive paths, `/home/...` or
   `/Users/...` paths, or CRLF line endings.

A suite-level test additionally verifies the generated module matches
the packs on disk byte for byte.

## Content quality bar

- Vendor-neutral and generic: no company names, internal tools, cloud
  products, or framework lock-in. The template must be useful in any
  codebase.
- English, LF line endings, plain Markdown — no HTML, no front matter.
- `<angle-bracket>` placeholders for content the spec author fills in by
  hand; spec analysis blocks approval until they are replaced. The
  template gives structure; the engineering judgment stays with the
  author.
- EARS-shaped acceptance criteria in requirements files: `WHEN <event>,
  THE SYSTEM SHALL <behavior>.` and `IF <error condition>, THEN THE
  SYSTEM SHALL <safe behavior>.`
- Concrete task verbs in `tasks.md.template` — "Implement", "Add
  regression tests", "Verify" — not vague "handle" or "support".
- A README that documents every variable in a table and shows a
  copy-pasteable `preview`/`apply` example (see
  `packages/templates/builtins/rest-api/README.md` as the reference).

## Pull request checklist

- [ ] `specbridge template validate packages/templates/builtins/<id>`
      passes with no errors (ideally `--strict`).
- [ ] The pack README documents every variable and shows a working
      usage example.
- [ ] Render check is clean: no error-severity rendering issues.
- [ ] End-to-end apply passes spec analysis
      (`npx vitest run tests/templates/builtin-packs.test.ts`).
- [ ] `pnpm generate:builtin-templates` and
      `pnpm generate:template-gallery` were run and the regenerated
      files are committed.
- [ ] No employer-specific or vendor-locked content.
- [ ] No absolute paths anywhere in the pack.
- [ ] LF line endings throughout.
- [ ] An example is included: the manifest `examples` array carries a
      copy-pasteable apply command (it appears in the generated
      gallery).

## Related documentation

- [Template overview](templates.md)
- [Creating templates](creating-templates.md)
- [Manifest reference](template-manifest.md)
- [Rendering rules](template-rendering.md)
- [Installation](template-installation.md)
- [Security](template-security.md)
