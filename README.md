# SpecBridge

[![CI](https://github.com/HelloThisWorld/specbridge/actions/workflows/ci.yml/badge.svg)](https://github.com/HelloThisWorld/specbridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An open, model-agnostic spec runtime for existing Kiro projects.

Bring your current `.kiro/steering` and `.kiro/specs` files to Claude Code,
Codex, local models, or any supported coding agent.

**No conversion. No duplicated specs. No lock-in.**

> Start in Kiro. Continue anywhere. Return whenever you want.

> Your `.kiro` specs remain the source of truth.

```sh
cd your-kiro-project        # any project that already contains .kiro/
npx specbridge doctor       # read-only health check — nothing is modified
npx specbridge spec list
```

*(Until the first npm release, build from source — see
[Quickstart](#quickstart-from-source).)*

SpecBridge is an independent open-source project, **not affiliated with,
endorsed by, or sponsored by AWS or Kiro** — see [NOTICE.md](NOTICE.md).

---

## Why this exists

Kiro popularized a great idea: keep requirements, design, and tasks as plain
Markdown in your repository (`.kiro/specs/<name>/requirements.md`,
`design.md`, `tasks.md`). But the files that make the workflow portable are
easy to strand: switch tools and your specs become inert documentation.

SpecBridge is a CLI-first runtime for those files. It reads your existing
`.kiro` directory directly and makes the specs usable with **any** coding
agent — while guaranteeing Kiro can still open the project tomorrow.

It is useful for:

1. Kiro users who want to stop paying for Kiro while keeping their specs alive.
2. People who want Kiro-style specs with Claude Code or another agent.
3. Teams that want specs stored in the repo and verified in CI.
4. Anyone who wants the option to return to Kiro later, with zero migration.

SpecBridge is **not** a Kiro clone, a VS Code fork, a chat UI, a new spec
format, or a wrapper around one model.

## The zero-migration promise

Point SpecBridge at an existing Kiro project and it works. You never:

- export or convert specs
- copy specs to a second location
- change the folder structure
- regenerate requirements
- lose the ability to reopen the project in Kiro

SpecBridge never renames `.kiro` files, never adds front matter or tool
metadata to them, and never reformats a document to change one checkbox.
Runtime state lives in a separate `.specbridge/` directory
([docs/sidecar-state.md](docs/sidecar-state.md)).

## Supported directory structure

```
your-project/
├── .kiro/                          # source of truth — owned by you and Kiro
│   ├── steering/
│   │   ├── product.md
│   │   ├── tech.md
│   │   ├── structure.md
│   │   └── *.md                    # additional steering (front matter honored)
│   └── specs/
│       └── <spec-name>/
│           ├── requirements.md     # feature specs
│           ├── design.md
│           ├── tasks.md
│           ├── bugfix.md           # bugfix specs use bugfix.md instead of requirements.md
│           └── anything-else.*     # unknown files are listed and preserved
└── .specbridge/                    # SpecBridge runtime state (optional, separate)
    ├── config.json
    └── state/specs/<spec-name>.json
```

Partial specs (any subset of the files) are reported, never rejected.

## Quickstart from source

```sh
pnpm install
pnpm build

cd examples/existing-kiro-project
node ../../packages/cli/dist/index.js doctor
node ../../packages/cli/dist/index.js spec list
node ../../packages/cli/dist/index.js spec show user-authentication
node ../../packages/cli/dist/index.js spec context user-authentication
```

After the first npm release the same commands are `npx specbridge doctor`,
`npx specbridge spec list`, and so on.

What `doctor` prints for the example project:

```
SpecBridge Doctor

Workspace:
  ✓ Git repository detected
  ✓ .kiro directory detected
  ✓ .kiro/steering detected (5 files)
  ✓ .kiro/specs detected (3 specs)

Steering:
  ✓ product.md
  ✓ tech.md
  ✓ structure.md
  + 2 additional steering files (api-conventions.md, testing-standards.md)

Specs:
  ✓  login-timeout-fix      bugfix   complete  4/4 tasks
  !  notification-settings  feature  partial   requirements
  ✓  user-authentication    feature  complete  3/9 tasks (+1 optional)

Compatibility:
  ✓ No migration required — .kiro remains the source of truth
  ✓ No SpecBridge metadata inside .kiro files
  ✓ Round-trip safe: every Markdown file reserializes byte-identically
  ✓ Safe for read-only use

Result: OK — workspace is ready for SpecBridge
```

## CLI

Working today (fully offline, no model, no API key):

| Command | What it does |
| --- | --- |
| `specbridge doctor` | Workspace health, compatibility, and sidecar-state report |
| `specbridge steering list` | List steering files with inclusion modes |
| `specbridge steering show <name>` | Print a steering file |
| `specbridge spec new <name>` | **v0.2** — create a Kiro-compatible spec from offline templates |
| `specbridge spec analyze <name>` | **v0.2** — deterministic structural/consistency analysis |
| `specbridge spec approve <name> --stage <s>` | **v0.2** — record (or `--revoke`) a stage approval with a byte-exact hash |
| `specbridge spec status <name>` | **v0.2** — workflow status, stage approvals, stale detection |
| `specbridge spec list` | List specs with type, mode, files, progress, approval health |
| `specbridge spec show <name>` | Spec summary; `--file`, `--raw`, `--state`, `--analysis`, `--status`, `--json` |
| `specbridge spec context <name>` | Agent-ready context (`--format json`, `--target claude-code`) |
| `specbridge compat check [name]` | Prove the byte-identical no-op round trip |

Planned commands (`spec run/sync/verify/export`) are registered, marked
"(planned)" in `--help`, and exit with an honest error — see the
[roadmap](docs/roadmap.md). Every command supports `--help` with examples.

## Spec authoring and approval (v0.2)

Create specs, gate them through explicit approvals, and detect when an
approved document changes — all offline, no LLM anywhere:

```sh
specbridge doctor

specbridge spec new notification-preferences \
  --mode requirements-first \
  --description "Allow users to choose email and push notification preferences."

specbridge spec analyze notification-preferences --stage requirements

specbridge spec approve notification-preferences --stage requirements

specbridge spec status notification-preferences
```

How it fits together:

- **Templates, not generation.** `spec new` renders plain-Markdown templates
  (feature: requirements-first / design-first / quick; bugfix: report + fix
  design + plan). Generated placeholders like `<role>` are machine-
  recognizable, so a fresh template cannot be approved by accident —
  `spec analyze` reports them as errors until you write real content.
- **Approval is recorded, never inferred.** `spec approve` runs the
  deterministic analyzer (errors block, warnings do not), then stores the
  SHA-256 of the exact file bytes plus a timestamp in
  `.specbridge/state/specs/<name>.json`. The Markdown file is never touched.
- **Stale approvals are caught.** Change one byte of an approved file and
  `spec status` / `spec list` / `doctor` report `STALE_APPROVAL`, including
  which dependent approvals are now invalid. Read-only commands never
  rewrite state; re-approving is the explicit repair.
- **Existing Kiro projects just work.** Specs without SpecBridge state are
  reported as `unmanaged` and stay fully usable; the first successful
  approval initializes sidecar state (`origin: existing-kiro-workspace`).

Details: [spec authoring](docs/spec-authoring.md) ·
[deterministic analysis](docs/spec-analysis.md) ·
[approval workflow](docs/approval-workflow.md) ·
[sidecar state](docs/sidecar-state.md).

## Compatibility guarantees

SpecBridge implements compatibility with **publicly documented** Kiro file
locations, names, and observable document formats — nothing proprietary.
Details: [docs/kiro-compatibility.md](docs/kiro-compatibility.md).

The compatibility layer is line-preserving, not AST-based. It tolerates and
preserves:

- LF, CRLF, and even lone-CR line endings; UTF-8 BOMs; missing final newlines
- custom and unknown headings; hand-edited prose; HTML comments
- nested and flat task numbering; unnumbered tasks; optional tasks (`- [ ]*`)
- unusual checkbox states (`[-]`, `[~]`, malformed boxes are reported, never rewritten)
- incomplete specs (missing design.md, missing tasks.md, requirements only)
- unknown files inside spec folders
- non-English user-authored spec content (the repo itself stays English)

### The no-op round-trip guarantee

Loading a `.kiro` file and writing it back unchanged produces a
**byte-identical** file. This is enforced by tests on every fixture (golden
hashing workflow) and verifiable on *your* repository at any time:

```sh
specbridge compat check          # every spec + steering file
```

When SpecBridge does edit a file (later phases: checkbox updates), the edit
is surgical: one line changes, every other byte stays identical. That
behavior is also under test today.

## Workflows

The on-disk layout is identical for every feature workflow, so SpecBridge
records the workflow in sidecar state and reports `unknown` rather than
guessing when none exists.

- **Requirements-first** — requirements → design → tasks
  ([examples/requirements-first-project](examples/requirements-first-project))
- **Design-first** — design → requirements → tasks
  ([examples/design-first-project](examples/design-first-project))
- **Quick** — all files generated in one step, approvals in any order
  ([examples/quick-spec-project](examples/quick-spec-project))
- **Bugfix** — `bugfix.md` (Current/Expected/Unchanged Behavior…) + design + tasks
  ([examples/bugfix-spec-project](examples/bugfix-spec-project))

All four are created offline by `specbridge spec new` (since v0.2) and gated
by `spec approve` — see [docs/approval-workflow.md](docs/approval-workflow.md).
Runner-assisted content generation is a separate, later phase and will always
be opt-in.

## Claude Code integration

`specbridge spec context <name> --target claude-code` produces a single
document with steering, spec content, task progress, and working agreements
(surgical checkbox edits, `.kiro` is the source of truth, run
`compat check` after edits).

A Claude Code skill wrapping the CLI lives at
[integrations/claude-code/skills/specbridge](integrations/claude-code/skills/specbridge/SKILL.md).
The CLI remains the product core; the skill is a thin wrapper.
More: [docs/claude-code-integration.md](docs/claude-code-integration.md).

## Spec drift verification

The headline differentiator: deterministic, LLM-free verification that code
changes match the spec — tasks marked done without evidence, changes outside
declared impact areas, criteria no task references, and more.

**Status:** the deterministic checks ship today as a tested library
([`@specbridge/drift`](packages/drift)); the `specbridge spec verify` CLI
command and CI gate land in Phase H. Design: [docs/spec-drift.md](docs/spec-drift.md).

Planned CI usage:

```sh
npx specbridge spec verify --changed --fail-on-drift
```

Exit codes: `0` passed · `1` drift / quality-gate failure · `2` configuration
or runtime error.

## GitHub Action

A preview composite action runs the read-only gates that exist today
(`doctor` + `compat check`):
[integrations/github-action](integrations/github-action/README.md). Drift
gates join it in Phase H. CI for this repository runs on Linux, macOS, and
Windows with Node 20 and 22 — no model, no API key.

## Supported runners

Runners make SpecBridge model- and agent-agnostic. Default commands never
require one.

| Runner | Status |
| --- | --- |
| `mock` | ✅ Implemented — offline, deterministic, used by tests |
| `claude-code` | 🚧 Detection only (`isAvailable`); generation lands in Phase F |
| `codex` | 🚧 Detection only; generation lands in Phase F |
| `ollama` | ❌ Stub — honestly not implemented |
| `openai-compatible` | ❌ Stub — honestly not implemented |

Configuration lives in `.specbridge/config.json`
([docs/runner-adapters.md](docs/runner-adapters.md)). Never commit API keys.

## Security and privacy

- Default commands are read-only and fully offline; no telemetry, no network.
- Writes (later phases) are atomic, path-checked against traversal, and
  confined to the workspace.
- Spec content is treated as data — never executed as shell commands or
  trusted as instructions.
- Runner execution is always explicit; verification commands come from
  trusted project configuration, never from model output.
- Logs never include secrets or environment variables.

## Limitations (v0.2)

- Task execution, sync, drift-verification CLI, and export are not
  implemented yet (they fail honestly; the drift library primitives exist).
- `spec new` renders offline templates only — no model writes content in
  v0.2, by design. Runner-assisted generation is a future opt-in.
- Analysis is deterministic and structural; it cannot judge whether
  requirements are *good*, only whether they are well-formed and complete.
- Workflow order cannot be inferred without sidecar state (reported as
  `unknown` — by design); the first approval of an existing Kiro spec infers
  it only when unambiguous.
- Files that are not valid UTF-8 are read best-effort and never edited.
- The GitHub Action is a preview and needs specbridge installed in the workflow.
- Setext (`===` underline) headings are not recognized as section boundaries;
  the bytes are preserved regardless.

## Roadmap

v0.1: read-only compatibility, doctor, listing, context, round-trip proof.
v0.2 (this release): offline spec authoring, deterministic analysis,
hash-based approvals, stale-approval detection. Next: runner adapters (F),
task execution with evidence (G), sync + drift verification (H), GitHub
Action (I), Claude Code skill polish (J), optional MCP server (K).
Full detail: [docs/roadmap.md](docs/roadmap.md).

## Documentation

[Architecture](docs/architecture.md) ·
[Kiro compatibility](docs/kiro-compatibility.md) ·
[Spec authoring](docs/spec-authoring.md) ·
[Spec analysis](docs/spec-analysis.md) ·
[Approval workflow](docs/approval-workflow.md) ·
[Sidecar state](docs/sidecar-state.md) ·
[Spec drift](docs/spec-drift.md) ·
[Runner adapters](docs/runner-adapters.md) ·
[Claude Code integration](docs/claude-code-integration.md) ·
[Migration from Kiro](docs/migration-from-kiro.md) (spoiler: there is none) ·
[Roadmap](docs/roadmap.md) ·
[Changelog](CHANGELOG.md)

## License and trademarks

MIT — see [LICENSE](LICENSE).

SpecBridge is an independent open-source project. It is not affiliated with,
endorsed by, or sponsored by Amazon Web Services or Kiro. Kiro is referenced
only to describe compatibility with publicly documented project files and
workflows. No Kiro proprietary prompts, source code, private APIs, logos, or
visual assets are included. See [NOTICE.md](NOTICE.md).
