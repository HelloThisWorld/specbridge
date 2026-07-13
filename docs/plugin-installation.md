# Plugin installation

Requirements: Claude Code with plugin support and Node.js 20+ on `PATH`.
The plugin is fully self-contained — installing it never runs npm and never
touches the network for normal operation.

## From GitHub (recommended)

Inside Claude Code:

```text
/plugin marketplace add HelloThisWorld/specbridge
/plugin install specbridge@specbridge-plugins
/reload-plugins
```

Then, inside a project that contains (or will contain) a `.kiro` directory:

```text
/specbridge:doctor
```

> SpecBridge is **not** published to Anthropic's official marketplace,
> and it is **not** published to any community marketplace either;
> the repository itself is the marketplace
> (`.claude-plugin/marketplace.json` at its root).

## From a local checkout (marketplace mode)

From the repository root, after `pnpm build:plugin`:

```text
/plugin marketplace add .
/plugin install specbridge@specbridge-plugins
/reload-plugins
```

## Development mode (no marketplace)

```bash
claude --plugin-dir ./integrations/claude-code-plugin/specbridge
```

This loads the plugin for one session without installing it — ideal while
iterating on skills. See [plugin-development.md](plugin-development.md).

## The ZIP artifact

`pnpm build:plugin` also produces
`dist/specbridge-claude-plugin-0.5.0.zip` (plugin root at the archive root).
Where your Claude Code version supports it:

```bash
claude --plugin-dir ./dist/specbridge-claude-plugin-0.5.0.zip
```

## Verifying an installation

```text
/specbridge:doctor
```

reports the workspace, the `.specbridge` configuration status, and the MCP
server health. From a terminal, the bundled CLI offers the same checks:

```bash
"<plugin-root>/bin/specbridge" mcp doctor
```

(`<plugin-root>` is where Claude Code installed the plugin; `/plugin` shows
it. On Windows use `bin\specbridge.cmd`.)

## Updating

```text
/plugin marketplace update specbridge-plugins
/plugin update specbridge@specbridge-plugins
/reload-plugins
```

## Removing

```text
/plugin uninstall specbridge@specbridge-plugins
/plugin marketplace remove specbridge-plugins
```

Removal never touches your project: `.kiro` content and `.specbridge`
runtime state stay exactly where they are.

## First workflow after installing

```text
/specbridge:status                          see the specs in this project
/specbridge:author my-spec requirements    draft + validate + review + apply
/specbridge:approve my-spec requirements   YOUR explicit approval
/specbridge:implement my-spec              verified task execution
/specbridge:verify                          deterministic drift checks
```
