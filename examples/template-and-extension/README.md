# Example: templates and extensions

A minimal workspace (one steering file, one draft spec: `webhook-retry`)
for walking through the two v0.7 ecosystems from the command line:

- **templates** — data-only spec scaffolds (JSON manifest + Markdown with
  `{{variable}}` placeholders); no scripts, no network, no model
- **extensions** — out-of-process add-ons that install **disabled** and run
  only after you explicitly accept their declared permissions

All commands below run offline from this directory (after
`pnpm install && pnpm build` at the repository root):

```sh
cd examples/template-and-extension
```

## Part 1 — templates (offline, read-only)

Ten built-in templates ship with SpecBridge. Discover, inspect, and preview
one without writing anything:

```sh
node ../../packages/cli/dist/index.js template search rest-api
node ../../packages/cli/dist/index.js template show rest-api
node ../../packages/cli/dist/index.js template preview rest-api --name orders-endpoint --var resourceName=order
```

Expected summaries:

`template search rest-api` — one hit from the built-in source:

```text
✓ builtin:rest-api — REST API v1.0.0
```

`template show rest-api` — the manifest rendered: kind, workflow modes,
tags, the three stage files, and every `--var` with defaults and
descriptions.

`template preview ...` — the fully rendered requirements/design/tasks
content, and this guarantee in the first line:

```text
Template preview — nothing was written
```

Applying is one flag away (`template apply`, same arguments) — it creates a
normal Kiro spec whose stages start **unapproved**; templates never bypass
the approval workflow. This walkthrough sticks to the read-only commands;
see [docs/templates.md](../../docs/templates.md) for apply, installation of
project templates, and the security limits (templates cannot execute code,
read the environment, or write outside `.kiro/specs/<name>/`).

## Part 2 — extension discovery (offline, read-only)

SpecBridge ships a built-in registry index describing the five reference
extensions maintained in [examples/extensions/](../extensions):

```sh
node ../../packages/cli/dist/index.js registry list
node ../../packages/cli/dist/index.js registry search analyzer
node ../../packages/cli/dist/index.js extension list
```

Expected summaries:

```text
Registries (1)
  ✓ examples (builtin, enabled, readable, 5 extensions)
```

```text
Registry search: analyzer (1)
  ✓ example-analyzer@1.0.0 (analyzer, from examples)
```

```text
Installed extensions (0)
```

Registry search is offline and deterministic (it reads the built-in and
cached indexes; fetching an https registry requires an explicit
`registry update <name> --network`). Listing is not endorsement.

## Part 3 — install and run the reference analyzer

> The steps below install code into `.specbridge/extensions/` and — after
> your explicit permission acceptance — execute it out of process. They are
> shown as documentation and are **not** run by this repository's example
> validation. Run them yourself in a scratch copy if you want to see the
> full loop.

Package the reference analyzer, then install the archive — installation
runs no code and leaves the extension disabled:

```sh
node ../../packages/cli/dist/index.js extension package ../extensions/example-analyzer --output ./tmp-pkg
node ../../packages/cli/dist/index.js extension install ./tmp-pkg/example-analyzer-1.0.0.specbridge-extension.zip
```

```text
✓ installed (disabled; no code was executed)
  permission hash: <64-hex-digit hash>
```

Inspect exactly what it may do. `show` prints the full permission
declaration and its hash:

```text
permissions:
  specRead: yes — receives bounded spec content
  repositoryRead: no
  repositoryWrite: no
  network: no
  childProcess: no
  environmentVariables: none
```

Enabling requires echoing the **exact** hash back — that is the consent
step, and a wrong hash is rejected (SBE017):

```sh
node ../../packages/cli/dist/index.js extension show example-analyzer
node ../../packages/cli/dist/index.js extension enable example-analyzer --accept-permissions <hash-from-show>
```

Only now can the analyzer run, out of process, against the draft spec in
this workspace:

```sh
node ../../packages/cli/dist/index.js spec analyze webhook-retry --stage requirements --extension example-analyzer
```

```text
extension analyzers:
  ✓ example-analyzer@1.0.0: no findings
Result: OK
```

Honest boundaries (see [docs/extensions.md](../../docs/extensions.md) and
[docs/extensions/security.md](../../docs/extensions/security.md)): process
isolation and permission declarations are safety boundaries and audit
mechanisms, **not an OS sandbox**; archive checksums prove integrity, not
publisher identity. Extensions can never approve stages, complete tasks, or
disable built-in protected-path rules.

Parts 1 and 2 are exercised by `node scripts/validate-examples.mjs` against
a temporary copy of this directory; Part 3 is intentionally not.
