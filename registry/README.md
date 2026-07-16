# SpecBridge community extension registry

This directory is the repository-managed extension registry index.

- `index.json` — the versioned registry index (`schemaVersion 1.0.0`). It is
  embedded into SpecBridge as the built-in `examples` registry and can also be
  added explicitly as a local-file registry:

  ```bash
  specbridge registry add local-examples --file ./registry/index.json
  specbridge registry search analyzer
  ```

- `entries/<extension-id>.json` — one file per extension, mirrored into
  `index.json` by `pnpm generate:extension-registry`.
- `schema.json` — a JSON Schema description of the index document.

## What a registry is (and is not)

A registry is a **metadata index**. It never contains executable content,
searching it never executes code, and updating it never installs anything.
Archive `sha256` values prove download integrity only — they do not prove
publisher identity, and **being listed is not an endorsement**. Users review
an extension's permissions and accept them explicitly before it can run.

## Maintenance

The index currently lists only the maintained reference extensions from
`examples/extensions/`. Archive URLs use the `example.invalid` placeholder
host until a real hosted registry exists; the hashes are real and
reproducible because `specbridge extension package` builds deterministic
archives.

```bash
pnpm generate:extension-registry   # rebuild index + entries (needs pnpm build)
pnpm generate:builtin-registry     # re-embed the index into @specbridge/registry
pnpm validate:extension-registry   # deterministic structural validation
```

CI runs `pnpm validate:extension-registry` and `pnpm check:builtin-registry`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose an entry.
