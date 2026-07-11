# Example: quick workflow

All three spec files were generated in one step and lightly edited — the
"quick" workflow. On disk the spec looks exactly like any other feature spec;
the sidecar state records `workflowMode: "quick"` so tools and teammates know
the documents were not individually reviewed stage-by-stage.

```sh
cd examples/quick-spec-project
node ../../packages/cli/dist/index.js spec list     # MODE column reads quick
```
