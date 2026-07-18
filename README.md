# SpecBridge

An open, model-agnostic spec runtime for existing Kiro projects.

**No conversion. No duplicated specs. No lock-in.**

> Start in Kiro. Continue anywhere. Return whenever you want.

```text
existing .kiro specs
        ↓
approve requirements, design, and tasks
        ↓
implement with Claude Code / Codex / Gemini
        ↓
capture real Git evidence
        ↓
verify spec drift locally and in CI
        ↓
extend with templates and extensions
```

30-second start in any project that already contains `.kiro/`:

```bash
npm install -g specbridge-cli
specbridge doctor
specbridge spec list
specbridge spec verify --changed
```

Using Claude Code? Install the self-contained plugin instead:
`/plugin marketplace add HelloThisWorld/specbridge` →
`/plugin install specbridge@specbridge-plugins` —
[details](docs/getting-started/claude-code-plugin.md).

[![CI](https://github.com/HelloThisWorld/specbridge/actions/workflows/ci.yml/badge.svg)](https://github.com/HelloThisWorld/specbridge/actions/workflows/ci.yml)
[![skill test](https://github.com/HelloThisWorld/specbridge/actions/workflows/skill-verification.yml/badge.svg)](https://github.com/HelloThisWorld/agent-skill-verification-template)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**[Documentation hub](docs/README.md)** ·
**[Releases](https://github.com/HelloThisWorld/specbridge/releases)**

Maturity, honestly: v1.0.0 has a deterministic, offline core (parsing,
approvals, verification, evidence) with stable public contracts, while
model-assisted parts remain inherently nondeterministic, extensions run
out of process but are not OS-sandboxed, and release binaries are
unsigned — see [SECURITY.md](SECURITY.md) and the
[threat model](docs/security/threat-model.md).

SpecBridge is an independent open-source project, **not affiliated with,
endorsed by, or sponsored by AWS or Kiro** — see [NOTICE.md](NOTICE.md).

---

## Why this exists

Kiro popularized a great idea: spec-driven development with requirements,
design, and tasks as plain Markdown in your repository
(`.kiro/specs/<name>/requirements.md`, `design.md`, `tasks.md`). But the
files that make the workflow portable are easy to strand: switch tools and
your specs become inert documentation.

SpecBridge is a Kiro-compatible, CLI-first runtime for those files. It
reads your existing `.kiro` directory directly and makes the specs usable
with **any** supported AI coding agent — Claude Code, the Codex CLI, the
Gemini CLI, local models — while guaranteeing Kiro can still open the
project tomorrow.

It is useful for:

1. Kiro users who want to stop paying for Kiro while keeping their specs alive.
2. People who want Kiro-style specs with Claude Code or another agent.
3. Teams that want specs stored in the repo and verified in CI.
4. Anyone who wants the option to return to Kiro later, with zero migration.

SpecBridge is **not** a Kiro clone, a VS Code fork, a chat UI, a new spec
format, or a wrapper around one model.

## The zero-migration promise

Point SpecBridge at an existing Kiro project and it works. You never
export, convert, copy, restructure, or regenerate anything — and you never
lose the ability to reopen the project in Kiro. SpecBridge never renames
`.kiro` files, never adds front matter or tool metadata to them, and the
no-op round trip is **byte-identical** (enforced by tests, verifiable on
your repository with `specbridge compat check`). Runtime state lives in a
separate `.specbridge/` directory
([sidecar state](docs/sidecar-state.md)); details in
[Kiro compatibility](docs/kiro-compatibility.md) and
[using an existing Kiro project](docs/getting-started/existing-kiro-project.md).

## What it does

**Spec workflow and approvals** — create Kiro-compatible specs offline
(`spec new`, four workflows, ten templates), analyze them
deterministically, and gate every stage behind an explicit human approval
recorded as a SHA-256 of the exact file bytes. Stale approvals are
detected, never papered over.
[Authoring](docs/spec-authoring.md) ·
[approvals](docs/approval-workflow.md)

**Deterministic spec drift verification** — the headline differentiator:
LLM-free agent verification that implementation changes still match the
approved specs. 26 stable rule IDs (SBV001–SBV026) cover approval drift,
evidence freshness, requirements traceability, scope, and trusted
verification commands, with terminal/JSON/Markdown/HTML reports. It does
not claim semantic proof — heuristic findings are labelled and never
default to error.
[Verification](docs/spec-drift-verification.md) ·
[rules](docs/verification-rules.md)

**CI quality gates** — a bundled node20 GitHub Action runs the same
verification on pull requests: no model, no API key, no network, bounded
rule-ID annotations, Step Summary.
[GitHub Action](docs/github-action.md) ·
[CI quality gates](docs/ci-quality-gates.md)

**Evidence-gated task execution** — a runner (or your live Claude Code
session, via the plugin) implements one approved task per run. The
repository is snapshotted before and after; model claims are recorded as
claims; the task checkbox flips only after trusted verification commands
pass or an explicit, audited manual acceptance.
[Task execution](docs/task-execution.md) ·
[evidence](docs/execution-evidence.md)

**Model-agnostic runners** — capability-checked profiles decide what each
provider may do; network-backed endpoints are never selected implicitly,
and no provider claim is ever treated as proof:

| Profile | Support | Author | Execute tasks |
| --- | --- | --- | --- |
| claude-code | production | yes | yes |
| codex-default | production | yes | yes |
| gemini-default | production | yes | capability-gated |
| ollama-local | production | yes | no (by capability) |
| openai-compatible-local | production | yes | no (by capability) |
| antigravity | experimental | no | no |

SpecBridge includes no provider subscriptions or credentials — you install
and authenticate Claude Code, the Codex CLI, the Gemini CLI, Ollama, or
your API endpoint yourself; API keys are referenced by environment-variable
name only and never stored. [Runners](docs/runners.md)

**MCP server and Claude Code plugin** — a local stdio MCP server (37
typed tools, 7 resources, 4 prompts) exposes the same core, and a
self-contained Claude Code plugin bundles CLI + server + eleven skills
(all eleven verified against a live model).
[MCP server](docs/mcp-server.md) ·
[plugin](docs/claude-code-plugin.md) ·
[skill verification](docs/skill-verification/README.md)

**Templates and extensions** — reusable spec templates (deterministic
offline `{{variable}}` rendering, no executable generators) and five
extension kinds running out of process behind a versioned stdio protocol
with manifest-hash-bound permissions. Extensions can never approve stages,
complete tasks, or alter evidence.
[Templates](docs/templates.md) · [extensions](docs/extensions.md)

**Migrations and recovery** — nothing migrates automatically, ever.
`migrate status|plan|apply|verify`, `state validate`, and hash-bound
`state recover` make every state change explicit, previewed, backed up,
and reversible. [Migrations & recovery](docs/migrations/README.md)

## Installation

| Method | How | Notes |
| --- | --- | --- |
| npm | `npm install -g specbridge-cli` | command is `specbridge`; one-off: `npx -p specbridge-cli specbridge doctor` |
| Standalone archives | [Releases page](https://github.com/HelloThisWorld/specbridge/releases) | windows-x64, linux-x64, macos-x64, macos-arm64, portable Node; `SHA256SUMS` provided; binaries unsigned |
| Claude Code plugin | `/plugin marketplace add HelloThisWorld/specbridge` | then `/plugin install specbridge@specbridge-plugins` |
| GitHub Action | `uses: HelloThisWorld/specbridge/integrations/github-action@v1.0.0` | [docs](docs/github-action.md) |
| From source | `pnpm install && pnpm build` | Node 20+, pnpm 9 |

Full details: [installation](docs/getting-started/installation.md) ·
[quickstart](docs/getting-started/quickstart.md).

## Security and privacy

- Default commands are read-only and fully offline; no telemetry.
- Writes are atomic, path-checked, and confined to the workspace; spec
  content and model output are treated as data, never as instructions.
- Verification commands come from trusted project configuration (argv
  arrays, no shell) — never from spec text or model output.
- No credentials are ever collected, stored, or printed; permission
  bypasses are rejected at three layers.
- Full model: [security](docs/security.md) ·
  [threat model](docs/security/threat-model.md) ·
  [reporting a vulnerability](SECURITY.md).

## Architecture

A pnpm workspace of small, single-purpose TypeScript packages (tolerant
line-preserving parsers, workflow state machine, drift rule engine, runner
platform, MCP server, extension host) — see
[architecture](docs/architecture.md).

## History

v0.1 shipped read-only Kiro compatibility with the byte-identical
round-trip guarantee; v0.2 offline authoring and hash-based approvals;
v0.3 the runner contract and evidence-gated task execution; v0.4 the
deterministic drift verification engine and GitHub Action; v0.5 the MCP
server, interactive execution, and the Claude Code plugin; v0.6.x the
capability-driven multi-runner platform (Codex CLI, Gemini CLI, Ollama,
OpenAI-compatible); v0.7.x templates and the out-of-process extension
ecosystem. v1.0.0 froze the public contracts, added the unified
migration/recovery framework, and brought cross-platform packaging. Full
detail: [CHANGELOG](CHANGELOG.md) · [roadmap](docs/roadmap.md).

## Documentation, contributing, support

- [Documentation hub](docs/README.md) — every guide and reference, by
  area.
- [Contributing](CONTRIBUTING.md) · [support](SUPPORT.md) ·
  [code of conduct](CODE_OF_CONDUCT.md) ·
  [security policy](SECURITY.md).

## License and trademarks

MIT — see [LICENSE](LICENSE).

SpecBridge is an independent open-source project. It is not affiliated with,
endorsed by, or sponsored by Amazon Web Services or Kiro. Kiro is referenced
only to describe compatibility with publicly documented project files and
workflows. No Kiro proprietary prompts, source code, private APIs, logos, or
visual assets are included. See [NOTICE.md](NOTICE.md).
