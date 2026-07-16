# example-analyzer

Deterministic spec diagnostics contributed by the example-analyzer analyzer extension.

A SpecBridge **analyzer** extension.

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
specbridge extension install ./dist/example-analyzer-1.0.0.specbridge-extension.zip
specbridge extension show example-analyzer
specbridge extension enable example-analyzer --accept-permissions <hash-from-show>
```

Installed extensions start disabled; enabling requires accepting the exact
permission hash shown by `extension show`.
