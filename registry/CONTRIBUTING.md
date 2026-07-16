# Contributing an extension to the registry

Anyone can propose an extension for the community index. The registry lists
metadata only — your code stays in your repository and your archive stays on
your HTTPS host.

## Before you open a pull request

1. Scaffold and implement your extension:

   ```bash
   specbridge extension scaffold my-analyzer --kind analyzer --output ./my-analyzer
   ```

2. Validate, test, and run conformance:

   ```bash
   specbridge extension validate ./my-analyzer
   specbridge extension conformance ./my-analyzer --yes
   ```

3. Package and note the printed archive SHA-256:

   ```bash
   specbridge extension package ./my-analyzer
   ```

4. Host the produced `.specbridge-extension.zip` at a stable, credential-free
   **HTTPS** URL.

## The registry entry

Add `registry/entries/<your-extension-id>.json` following the shape in
`schema.json` (see the existing example entries). Requirements:

- `id` matches the extension ID grammar (lowercase, digits, single hyphens)
- `kind` is one of: template-provider, analyzer, verifier, exporter, runner
- every version lists an HTTPS `archiveUrl` and its exact archive `sha256`
- `manifest.permissions` matches the manifest inside the archive exactly —
  understating permissions is grounds for removal
- `license` is present

Then regenerate the index and validate:

```bash
pnpm generate:extension-registry
pnpm validate:extension-registry
```

## What listing means

Listing is **not** endorsement, review, or a security guarantee. Users see
your declared permissions and must accept them explicitly (bound to your
manifest hash) before the extension can run. Checksums prove integrity, not
identity. Entries that misdeclare permissions, change published archives in
place, or violate the extension security model are removed.
