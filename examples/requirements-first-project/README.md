# Example: requirements-first workflow

A feature spec authored requirements → design → tasks. The workflow order is
not stored in `.kiro` (the file layout is identical for every workflow), so
SpecBridge records it in sidecar state at
`.specbridge/state/specs/notification-preferences.json` — approvals included.
The `.kiro` files carry no SpecBridge metadata.

```sh
cd examples/requirements-first-project
node ../../packages/cli/dist/index.js spec list     # MODE column reads requirements-first
node ../../packages/cli/dist/index.js spec show notification-preferences
```

Like every example, this workspace is exercised offline against a temporary
copy by `node scripts/validate-examples.mjs`.
