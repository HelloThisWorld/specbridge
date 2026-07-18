# Example: design-first workflow

The team explored the architecture first, then backfilled requirements. The
file layout is identical to a requirements-first spec — only the sidecar
state (`.specbridge/state/specs/export-pipeline.json`) records the order.
Without sidecar state, SpecBridge reports the workflow as `unknown` rather
than guessing.

```sh
cd examples/design-first-project
node ../../packages/cli/dist/index.js spec list     # MODE column reads design-first
```

Like every example, this workspace is exercised offline against a temporary
copy by `node scripts/validate-examples.mjs`.
