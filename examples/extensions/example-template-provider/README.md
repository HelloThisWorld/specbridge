# example-template-provider

Spec template packs contributed by the example-template-provider template-provider extension.

A SpecBridge **template-provider** extension.

## Develop

- Template packs live under `templates/<template-id>/` in the standard
  v0.7.0 `specbridge-template.json` format. This extension is data-only:
  it has no entrypoint and never runs code.

## Validate, test, package

```bash
specbridge extension validate .
specbridge extension package .
```

The package command prints the archive SHA-256 — publish that hash with your
archive. Checksums prove integrity, not publisher identity.

## Install locally

```bash
specbridge extension install ./dist/example-template-provider-1.0.0.specbridge-extension.zip
specbridge extension show example-template-provider
specbridge extension enable example-template-provider --accept-permissions <hash-from-show>
```

Installed extensions start disabled; enabling requires accepting the exact
permission hash shown by `extension show`.
