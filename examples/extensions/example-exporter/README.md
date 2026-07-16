# example-exporter

Candidate export files produced by the example-exporter exporter extension.

A SpecBridge **exporter** extension.

## Develop

- `dist/extension.cjs` is the self-contained artifact SpecBridge runs (works as scaffolded).
- `src/extension.mjs` shows the same handler built on `@specbridge/extension-sdk`; bundle it
  to `dist/extension.cjs` (see package.json) once you add dependencies.
- stdout is protocol-only; log with `context.log(...)` / stderr.

## Validate, test, package

```bash
specbridge extension validate .
node --test test/
specbridge extension conformance . --yes
specbridge extension package .
```

The package command prints the archive SHA-256 — publish that hash with your
archive. Checksums prove integrity, not publisher identity.

## Install locally

```bash
specbridge extension install ./dist/example-exporter-1.0.0.specbridge-extension.zip
specbridge extension show example-exporter
specbridge extension enable example-exporter --accept-permissions <hash-from-show>
```

Installed extensions start disabled; enabling requires accepting the exact
permission hash shown by `extension show`.
