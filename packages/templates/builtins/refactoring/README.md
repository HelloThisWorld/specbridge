# Refactoring template

A feature spec template for a behavior-preserving restructuring.

It pre-structures the spec around the questions refactors always raise: the
explicit inventory of behavior that must not change, the motivation, the
boundaries of the refactor, affected components and interfaces,
compatibility, an incremental plan with safe checkpoints, regression tests,
rollback points, and measurable completion criteria. It treats "unchanged
behavior" as a claim to verify with tests, not an assumption — even a pure
refactor can change performance, timing, and error messages.

## Usage

```bash
specbridge template preview refactoring \
  --name extract-billing-module \
  --var componentName=billing

specbridge template apply refactoring \
  --name extract-billing-module \
  --var componentName=billing
```

## Variables

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `componentName` | string | `the component` | The component, module, or subsystem being restructured. |

The built-in variables `specName`, `title`, `description`, `kind`, and
`mode` are always available and are set by `--name`, `--title`, and
`--description`.

## What you still fill in

The rendered documents contain `<angle-bracket>` placeholders and
"Add … here." lines by design. `specbridge spec analyze` blocks approval
until they are replaced with real content. The template gives structure;
the judgment about what must not change stays with you.
