# Codex plugin

The SpecBridge Codex plugin makes Codex a first-class conversation frontend
for the same local SpecBridge control plane used by the CLI and Claude Code.
It bundles all 16 frontend skills, the self-contained CLI, and the complete
stdio MCP server. Normal use needs Node.js 20+ but no global SpecBridge
installation, model API key, or network connection.

This integration is deliberately different from the `codex-default` runner:

```text
Codex conversation -> SpecBridge skills/MCP -> SpecBridge control plane
SpecBridge scheduler -> codex-cli / claude-code / another configured runner
```

Installing the frontend does not enable a runner, select a model, start a
nested `codex exec`, or change Codex sandbox or approval settings.

## Install from this repository

The local marketplace uses Codex's current `.agents/plugins/marketplace.json`
layout. From any shell, point Codex at the integration directory (not at the
plugin directory nested below it):

```text
codex plugin marketplace add ./integrations/codex-plugin
codex plugin list --marketplace specbridge-local --available --json
codex plugin add specbridge@specbridge-local
```

On Windows, an absolute path is often clearest:

```powershell
codex plugin marketplace add "D:\work\specbridge\integrations\codex-plugin"
codex plugin add specbridge@specbridge-local
codex plugin list --installed --json
codex mcp list
```

Open Codex in the repository you want SpecBridge to operate on. The current
Codex CLI has plugin add/remove commands; it does not expose a separate
enable/disable command. To remove this local installation:

```text
codex plugin remove specbridge@specbridge-local
codex plugin marketplace remove specbridge-local
```

These commands update the user's Codex plugin registry. The plugin itself
never reads credentials or edits Codex configuration.

## Use

Skills can be invoked explicitly with `$specbridge:<skill>` or selected by
Codex from their descriptions. The plugin contains the same public skill set
as the Claude Code frontend:

| Skill | Purpose |
| --- | --- |
| `approve` | Inspect an approval boundary and print the command for the human; never execute it |
| `author` | Draft, validate, review, and apply a spec stage |
| `build` | Run repository-grounded Spec Intake for a complete product specification |
| `continue` | Resume an interrupted interactive or governed run honestly |
| `develop` | Run the governed plan/review/implementation lifecycle |
| `discover` | Conduct Mission Discovery and compile confirmed product authority |
| `doctor` | Diagnose the workspace and bundled MCP connection |
| `extensions` | Inspect registered extensions without installing or executing them |
| `implement` | Implement one approved task in the current Codex conversation |
| `new` | Preview and create a Kiro-compatible spec |
| `orchestrate` | Inspect or operate persistent long-running jobs through the control plane |
| `runners` | Inspect runner profiles and their capability boundaries |
| `spec-draft` | Turn the current conversation into an intake-ready product specification |
| `status` | Summarize specs, intake, runs, and jobs |
| `templates` | Search, preview, and explicitly apply a template |
| `verify` | Check drift and optionally run trusted verification commands |

Examples:

```text
$specbridge:doctor
$specbridge:status checkout-redesign
$specbridge:spec-draft checkout-redesign
把我們剛才聊的整理成 spec
現在跑到哪裡了？
繼續剛才被中斷的工作
```

MCP is the primary structured surface. Skills call the server's typed tools
instead of parsing CLI output or duplicating lifecycle logic. Shell commands
are reserved for the explicit human approval boundary and troubleshooting.

## Conversation to unattended build

A complete flow can remain in one Codex conversation until human authority
is required:

1. Discuss the product change naturally.
2. Ask “把我們剛才聊的整理成 spec” or invoke
   `$specbridge:spec-draft`.
3. For a Brownfield repository, the skill reads or refreshes the current
   system snapshot and drafts a product delta rather than re-specifying
   existing capabilities.
4. Review the full Markdown draft. After the human confirms it, the skill
   writes the file and passes its complete text to `spec_intake_start`.
5. Codex presents only unresolved product questions. Each human answer is
   relayed verbatim through `spec_intake_answer`; Codex never invents one.
6. When intake converges, Codex shows the summary and this exact command,
   then stops:

   ```text
   specbridge spec approve <feature-name> --build
   ```

7. The human runs the command in their own terminal. The sealed build may
   then dispatch whichever runner the project explicitly configured.

No MCP tool can perform final approval. Conversation consent, an invoked
skill, or a model statement is never treated as an approval record.

### Semi-automated acceptance smoke

Use a disposable SpecBridge fixture with the Codex plugin installed; do not
start or use Claude Code. In Codex, conduct this conversation:

```text
User: I want a small feature that records a display name and exposes it in
the API. Let's discuss it first.

User: Looks good. Turn what we discussed into a SpecBridge spec.
```

Confirm that `spec-draft` acts as scribe, shows the complete draft and gaps,
waits for confirmation, writes the confirmed document, sends its full text
to `spec_intake_start`, presents any product question, and relays the human's
answer through `spec_intake_answer`. When intake converges it must show
`specbridge spec approve <feature-name> --build` and stop. Do not run the
approval command as part of the smoke.

In the same fixture, exercise the second flow:

```text
現在跑到哪裡了？
繼續剛才被中斷的工作
檢查一下 SpecBridge 環境有沒有問題
```

These map to `status`, `continue`, and `doctor`. The automated plugin suite
locks down their bilingual descriptions and workflow artifacts; the bundle
verifier independently starts the installed-shape MCP process, reads status-
relevant state, and performs a guarded write without Claude Code or a model.

## MCP launch and project-root resolution

`.mcp.json` starts `dist/mcp-launcher.cjs` through `${PLUGIN_ROOT}`. Codex may
install a plugin in a cache directory, so the launcher keeps that location
separate from the user's repository. It resolves the project as follows:

1. `SPECBRIDGE_PROJECT_ROOT`, when explicitly set;
2. the active Codex process working directory;
3. `PWD`, when available.

For the first usable candidate outside the plugin installation, it walks up
to the nearest `.kiro`, `.specbridge`, or `.git` marker. If no marker exists,
the existing directory is used as a Greenfield root. It then spawns the
shared MCP bundle with an argv array, `shell: false`, inherited stdio, and
the resolved project as `cwd`. This preserves Windows paths and paths that
contain spaces and prevents an installed plugin cache from becoming the
workspace by accident.

Set an explicit root only when the host cannot supply the project working
directory:

```powershell
$env:SPECBRIDGE_PROJECT_ROOT = "D:\projects\my app"
codex
```

The MCP server pins one canonical project root for its lifetime. Switch
projects by starting a new Codex task in the other repository.

## Security and authority

- No hook or `AGENTS.md` injection is required. The plugin does not install
  lifecycle hooks or rewrite repository guidance.
- No skill edits `.kiro` or `.specbridge` directly; writes use the guarded
  SpecBridge control plane.
- The `approve` skill only inspects state and prints a terminal command. It
  must stop without running that command.
- The MCP catalog contains no approval-shaped tool and no arbitrary shell or
  Git tool.
- Trusted verification commands come only from project configuration as
  argv arrays. Spec text and model output cannot supply commands.
- Evidence and trusted verification decide task completion; runner claims
  remain claims.
- The plugin does not change runner configuration, credentials, model
  selection, sandbox policy, or Codex's own approval policy.

## Troubleshooting

`codex plugin list --installed --json` does not show SpecBridge
: Re-add the marketplace using the directory that contains
`.agents/plugins/marketplace.json`, then install
`specbridge@specbridge-local` again.

`codex mcp list` does not show `specbridge`
: Remove and reinstall the plugin. Confirm the installed plugin contains
`.mcp.json` and `dist/mcp-launcher.cjs`.

`bundle_missing` appears on stderr
: The installed artifact is incomplete or stale. From a source checkout run
`pnpm build:plugin`, validate it, then reinstall the plugin.

`project_root_unavailable` appears on stderr
: Open Codex from the target project or set `SPECBRIDGE_PROJECT_ROOT` to an
existing directory. Do not point it at the plugin installation or cache.

Node cannot be found
: Install Node.js 20+ and make `node` available on `PATH`. The plugin bundles
SpecBridge, not the Node runtime.

The wrong project is detected
: Run `$specbridge:doctor`, check the Codex task's working directory, and use
an explicit `SPECBRIDGE_PROJECT_ROOT` only if the host launch context is
unavoidable. Restart the task after changing it.

An interrupted workflow exists
: Ask “繼續剛才被中斷的工作” or invoke `$specbridge:continue <run-id>`.
Use `$specbridge:status` to list likely runs and `$specbridge:doctor` for
environment or lock diagnostics.

## Development and validation

Claude skill files are the canonical behavioral source. The Codex builder
applies a small reviewed host adapter: Codex frontmatter and invocation names,
natural-language triggers, runner-neutral orchestration wording, and the
guidance-only approval skill. Runtime bundles are copied byte-for-byte, not
forked.

After changing any frontend skill or shared bundle:

```bash
pnpm build:plugin
pnpm check:codex-plugin
pnpm validate:plugin
pnpm validate:codex-plugin
pnpm verify:plugin-bundle
pnpm verify:codex-plugin-bundle
pnpm vitest run tests/plugin
```

`validate:codex-plugin` performs deterministic structure, parity, safety,
checksum, and shared-runtime checks. When `codex` is installed, it also uses
an isolated temporary `CODEX_HOME` for a real marketplace add/install/list/
remove cycle; it never mutates the developer's normal Codex configuration.
`verify:codex-plugin-bundle` copies the installed shape to a path containing
spaces, performs a real MCP handshake, lists tools, resolves a nested project,
executes a representative guarded state write, and checks clean stdio and
useful startup failures. No model, API key, global SpecBridge install, or
network connection is required.

When a new canonical skill is added, `pnpm build:plugin` generates its Codex
counterpart automatically. CI fails if skill names, generated content,
runtime bytes, checksums, or the committed plugin bundle drift.
