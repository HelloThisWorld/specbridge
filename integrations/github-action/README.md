# SpecBridge GitHub Action (preview)

Runs the read-only gates that exist in SpecBridge v0.1 on every PR:

- `specbridge doctor` — the `.kiro` workspace is healthy (exit 1 otherwise)
- `specbridge compat check` — every spec and steering file round-trips
  byte-identically (exit 1 otherwise)

Neither step needs a model, an API key, or network access beyond installing
the CLI.

## Status: preview

- **Requires the specbridge CLI to be runnable.** The default
  (`npx --yes specbridge`) works once specbridge is published to npm. Until
  then, build from source in a prior step and set `specbridge-command`.
- **Drift verification is not part of this action yet.** The planned inputs
  below become real in the drift phase (Phase H/I); they are documented so
  workflows can be sketched, not because they work today.

## Usage (today)

```yaml
- uses: actions/checkout@v4

- name: Verify .kiro spec compatibility
  uses: <owner>/specbridge/integrations/github-action@v0.1
  with:
    working-directory: .
    # spec: user-authentication   # optional: limit to one spec
```

Building from source until the npm release:

```yaml
- uses: actions/checkout@v4
  with: { repository: <owner>/specbridge, path: .specbridge-src }
- run: cd .specbridge-src && corepack enable && pnpm install --frozen-lockfile && pnpm build
- uses: <owner>/specbridge/integrations/github-action@v0.1
  with:
    specbridge-command: node ${{ github.workspace }}/.specbridge-src/packages/cli/dist/index.js
```

## Planned (Phase H/I — not implemented)

```yaml
- name: Verify spec alignment
  uses: <owner>/specbridge/integrations/github-action@v1
  with:
    spec: notification-preferences
    diff: origin/main...HEAD
    fail-on-drift: true
```

The drift-phase action will detect changed specs, run the deterministic
verifier, write a Markdown job summary, optionally upload HTML/JSON reports,
and fail the PR on configured quality gates — still with no model required.
Equivalent CLI: `npx specbridge spec verify --changed --fail-on-drift`.

Exit codes across all SpecBridge gates: `0` pass · `1` drift/quality-gate
failure · `2` configuration or runtime error.
