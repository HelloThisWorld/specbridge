# Example: bugfix workflow

A bugfix spec (`bugfix.md` + `design.md` + `tasks.md`) with no sidecar state —
exactly what you would have after working purely in Kiro. SpecBridge
classifies it as a bugfix spec from the file layout alone.

```sh
cd examples/bugfix-spec-project
node ../../packages/cli/dist/index.js spec show cart-total-rounding
node ../../packages/cli/dist/index.js spec context cart-total-rounding
```
