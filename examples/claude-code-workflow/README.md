# Example: Claude Code plugin workflow

A small, complete workspace showing what the SpecBridge Claude Code plugin
manages — and how every step of that workflow is also a plain CLI command
you can run **offline, with no model and no API key**.

The workspace contains one feature spec, `notification-digest`, exactly as
the plugin workflow leaves it mid-flight:

- `.kiro/specs/notification-digest/` — requirements, design, tasks
  (plain Kiro files; no SpecBridge metadata inside)
- `.kiro/steering/product.md` — one steering file
- `.specbridge/state/specs/notification-digest.json` — sidecar state with
  the **requirements and design stages approved** (each approval stores the
  SHA-256 of the exact file bytes) and the task plan still in draft, so the
  workflow status is `TASKS_DRAFT`

## 1. Install the plugin (reference)

Inside Claude Code:

```text
/plugin marketplace add HelloThisWorld/specbridge
/plugin install specbridge@specbridge-plugins
/reload-plugins
```

The repository itself is the marketplace (`specbridge-plugins`); the plugin
is self-contained and installs without npm or network access during normal
operation. Full instructions, local-checkout mode, and troubleshooting:
[docs/plugin-installation.md](../../docs/plugin-installation.md).

## 2. The workflow, skill by skill

Each plugin skill wraps CLI behavior — the plugin never has private powers:

| Plugin skill | CLI equivalent | Needs a model? |
| --- | --- | --- |
| `/specbridge:doctor` | `specbridge doctor` | no |
| `/specbridge:status` | `specbridge spec list` / `spec status` | no |
| `/specbridge:author <name> <stage>` | `specbridge spec generate` + `spec analyze` | yes (runner) |
| `/specbridge:approve <name> <stage>` | `specbridge spec approve` | no — approval is always yours |
| `/specbridge:implement <name>` | `specbridge spec run` | yes (runner) |
| `/specbridge:verify` | `specbridge spec verify` | no |

(The plugin ships eleven skills in total — `/specbridge:new`,
`/specbridge:continue`, `/specbridge:templates`, `/specbridge:extensions`,
and `/specbridge:runners` follow the same pattern. See
[docs/claude-code-plugin.md](../../docs/claude-code-plugin.md).)

## 3. Run the offline part yourself

From the repository root (after `pnpm install && pnpm build`):

```sh
cd examples/claude-code-workflow
node ../../packages/cli/dist/index.js doctor
node ../../packages/cli/dist/index.js spec list
node ../../packages/cli/dist/index.js spec status notification-digest
node ../../packages/cli/dist/index.js spec context notification-digest --target claude-code
node ../../packages/cli/dist/index.js spec verify notification-digest --working-tree
```

Expected output, summarized (a few stable lines per command, not full
transcripts):

`doctor` — the workspace is healthy and unconverted:

```text
✓ .kiro directory detected
✓ No migration required — .kiro remains the source of truth
Result: OK — workspace is ready for SpecBridge
```

`spec list` — one managed spec with its workflow mode and status:

```text
NAME                 TYPE     MODE                ...  STATUS
notification-digest  feature  requirements-first  ...  TASKS_DRAFT
```

`spec status notification-digest` — approvals verified against file bytes:

```text
Requirements  ✓ Approved   Content unchanged since approval
Design        ✓ Approved   Content unchanged since approval
Tasks         ● Draft      Prerequisites satisfied
```

`spec context notification-digest` — the agent-ready context document
(steering, requirements, design, tasks, working agreements) assembled
read-only; no model is invoked.

`spec verify notification-digest --working-tree` — deterministic drift
verification against git HEAD:

```text
Result: PASSED — 0 errors, 0 warnings, 0 info
```

`spec verify` compares against git history, so run it inside a git checkout
(this repository qualifies; nested `.kiro` workspaces are compared within
their own subtree). If you copy this example elsewhere, `git init` and
commit it first.

## 4. See drift detection fire

The approvals in the committed state hash the exact bytes of the approved
files. Change one byte and verification fails:

```sh
echo "drift" >> .kiro/specs/notification-digest/requirements.md
node ../../packages/cli/dist/index.js spec verify notification-digest --working-tree
# ✗ SBV002 — approved requirements changed after approval  → exit code 1
git checkout -- .kiro/specs/notification-digest/requirements.md   # verify passes again
```

(`scripts/demo.sh` / `scripts/demo.ps1` at the repository root run this
whole loop against a throwaway copy of this example.)

## 5. The model-assisted steps — honestly

`/specbridge:author` (drafting stage content) and `/specbridge:implement`
(executing tasks) invoke a configured agent runner. They are **not run by
this repository's example validation** and are not runnable offline. The
command shapes, for when you have a runner configured (see
[docs/runners.md](../../docs/runners.md)):

```sh
specbridge spec generate notification-digest --stage tasks   # model-assisted authoring
specbridge spec approve notification-digest --stage tasks    # your approval, offline
specbridge spec run notification-digest                      # verified task execution
```

Approval is never model-assisted: `spec approve` only records **your**
decision, as a SHA-256 over the exact file bytes, in sidecar state.

Everything in section 3 is exercised by `node scripts/validate-examples.mjs`
against a temporary copy of this directory.
