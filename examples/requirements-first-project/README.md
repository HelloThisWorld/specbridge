# Example: requirements-first workflow

A feature spec authored requirements → design → tasks. The workflow order is
not stored in `.kiro` (the file layout is identical for every workflow), so
SpecBridge records it in sidecar state at
`.specbridge/state/specs/notification-preferences.json` — approvals included.
The `.kiro` files carry no SpecBridge metadata.

```sh
cd examples/requirements-first-project
node ../../packages/cli/dist/index.js spec list     # WORKFLOW column reads requirements-first
node ../../packages/cli/dist/index.js spec show notification-preferences
```
