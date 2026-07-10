# Example: existing Kiro project

A realistic `.kiro` workspace exactly as Kiro would leave it — five steering
files and three specs in different states. Nothing here was converted or
annotated for SpecBridge; that is the point.

Try it (after `pnpm install && pnpm build` at the repository root):

```sh
cd examples/existing-kiro-project
node ../../packages/cli/dist/index.js doctor
node ../../packages/cli/dist/index.js spec list
node ../../packages/cli/dist/index.js spec show user-authentication
node ../../packages/cli/dist/index.js spec context user-authentication
node ../../packages/cli/dist/index.js compat check
```

Contents:

- `user-authentication` — complete feature spec (requirements, design, tasks)
- `notification-settings` — partial spec (requirements only)
- `login-timeout-fix` — complete bugfix spec (bugfix, design, tasks)
- steering: `product.md`, `tech.md`, `structure.md`, plus two additional files,
  one using `inclusion: fileMatch` front matter
