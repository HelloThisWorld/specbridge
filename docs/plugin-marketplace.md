# Plugin marketplace

The repository doubles as a Claude Code **marketplace** through
`.claude-plugin/marketplace.json` at its root:

```json
{
  "name": "specbridge-plugins",
  "owner": { "name": "HelloThisWorld" },
  "description": "Claude Code integrations for SpecBridge, the open spec runtime for existing Kiro projects.",
  "plugins": [
    {
      "name": "specbridge",
      "source": "./integrations/claude-code-plugin/specbridge",
      "version": "0.5.0",
      "license": "MIT",
      "category": "development",
      "strict": true
    }
  ]
}
```

Design decisions:

- **Relative source** — the plugin entry points at the in-repo plugin
  directory, so `/plugin marketplace add HelloThisWorld/specbridge` installs
  straight from a clone of this repository. The committed `dist/` bundles
  make that work without any build step.
- **Strict mode** — the plugin is validated against its manifest on
  install; nothing outside the declared structure is picked up.
- **Honest naming** — `specbridge-plugins` is plainly project-scoped. The
  marketplace never impersonates Anthropic, Claude, Kiro, or AWS, and no
  documentation claims presence in Anthropic's official or community
  marketplaces (SpecBridge is not published there).

Validation: `pnpm validate:plugin` checks the marketplace name, the
relative source resolution, version consistency with `plugin.json` and the
workspace, and cache-safe file references. `tests/plugin/plugin.test.ts`
runs the same checks in CI.

Local testing:

```text
/plugin marketplace add .
/plugin install specbridge@specbridge-plugins
/reload-plugins
```

See [plugin-installation.md](plugin-installation.md) for the user-facing
flow and [plugin-release.md](plugin-release.md) for release packaging.
