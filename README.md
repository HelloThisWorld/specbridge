# SpecBridge

[![CI](https://github.com/HelloThisWorld/specbridge/actions/workflows/ci.yml/badge.svg)](https://github.com/HelloThisWorld/specbridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An open, model-agnostic spec runtime for existing Kiro projects.

Bring your current `.kiro/steering` and `.kiro/specs` files to Claude Code,
Codex, local models, or any supported coding agent.

**No conversion. No duplicated specs. No lock-in.**

> Start in Kiro. Continue anywhere. Return whenever you want.

> Your `.kiro` specs remain the source of truth.

New in v0.7.0 — **reusable spec templates, without executable generators or
platform lock-in**:

```bash
specbridge template search migration

specbridge template preview database-migration \
  --name add-payment-status-index \
  --var tableName=payments

specbridge template apply database-migration \
  --name add-payment-status-index \
  --var tableName=payments
```

Ten built-in templates ship with SpecBridge — `rest-api`, `cli-tool`,
`database-migration`, `authentication`, `background-job`,
`event-driven-service`, `bugfix-regression`, `performance-optimization`,
`security-hardening`, `refactoring` — plus project-local packs, local
installation, and `template scaffold` for community templates. Templates
are plain Markdown plus a JSON manifest: rendering is deterministic and
offline (`{{variable}}` substitution only — no scripts, no network, no
model), preview writes nothing, apply never overwrites an existing spec,
and generated stages start unapproved like every other spec. See
[docs/templates.md](docs/templates.md).

From v0.6.1 — keep your existing `.kiro` specs and **choose a compatible
coding agent or authoring model per operation**:

```text
                  Spec authoring   Task execution
Claude Code             yes             yes
Codex CLI               yes             yes
Gemini CLI              yes             capability-gated
Ollama                  yes             no
OpenAI-compatible       yes             no
Antigravity CLI         experimental
```

```bash
specbridge runner matrix

specbridge runner doctor gemini-default

specbridge spec generate notification-preferences \
  --stage requirements \
  --runner gemini-default

specbridge spec refine notification-preferences \
  --stage design \
  --runner openai-compatible-local

specbridge spec run notification-preferences \
  --task 2.3 \
  --runner codex-default
```

Runner behavior is capability-driven: authoring-only model APIs (Ollama,
OpenAI-compatible endpoints) can never execute tasks, task execution needs
a proven safe boundary (Gemini task execution is enabled only when the
installed CLI proves a bounded edit policy without arbitrary shell access —
YOLO is never used), network-backed endpoints are never selected
implicitly, the Antigravity adapter is experimental detection only, and
whatever runs, task completion still requires actual Git evidence plus
trusted verification — never a provider claim. The live matrix above is
generated from registered runner metadata (`specbridge runner matrix`); not
every installed provider version is compatible (`specbridge runner doctor
<profile>` reports the exact capabilities).

SpecBridge does not include provider subscriptions, hosted model usage,
credentials, or authentication — you install and authenticate Claude Code,
the Codex CLI, the Gemini CLI, Ollama, or your API endpoint yourself. API
keys are referenced by environment-variable NAME only and never stored.
See [docs/runners.md](docs/runners.md).

From v0.5 — a self-contained **Claude Code plugin** with a local MCP
server and verified interactive task execution:

```text
/plugin marketplace add HelloThisWorld/specbridge
/plugin install specbridge@specbridge-plugins
/reload-plugins
```

Then, inside any project that contains `.kiro/`:

```text
/specbridge:doctor
/specbridge:status
/specbridge:implement notification-preferences 2.3
/specbridge:verify
```

```text
/specbridge:implement
        ↓
task_begin
        ↓
current Claude session edits
        ↓
task_complete
        ↓
Git evidence + trusted verification
        ↓
verified task completion
```

The plugin bundles everything (CLI + MCP server + skills) — no global npm
install, no nested Claude processes, and stage approval stays an explicit
human action. Deterministic spec drift verification (v0.4) still guards the
other end:

```text
approved spec
    + Git diff
    + task evidence
    + trusted verification
          ↓
    SpecBridge quality gate
```

```sh
cd your-kiro-project        # any project that already contains .kiro/
npx specbridge doctor       # read-only health check — nothing is modified
npx specbridge spec list

npx specbridge spec verify --changed \
  --diff origin/main...HEAD \
  --run-verification        # deterministic, offline, no model required
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
| `specbridge runner list / doctor / show` | **v0.3** — read-only runner diagnostics (executable, auth, capabilities) |
| `specbridge spec generate <name> --stage <s>` | **v0.3** — model-assisted stage drafting (result stays draft) |
| `specbridge spec refine <name> --stage <s>` | **v0.3** — model-assisted refinement with a unified diff |
| `specbridge spec run <name>` | **v0.3** — execute ONE approved task; evidence-gated checkbox completion |
| `specbridge spec accept-task <name> --task <id> --reason …` | **v0.3** — explicit, audited manual acceptance |
| `specbridge run list / show / resume` | **v0.3** — inspect append-only run records; resume interrupted sessions |
| `specbridge spec verify [name] \| --changed \| --all` | **v0.4** — deterministic drift verification against a git comparison (read-only) |
| `specbridge spec affected` | **v0.4** — which specs does this change set touch (read-only) |
| `specbridge spec policy init / show / validate` | **v0.4** — per-spec verification policies (impact areas, required commands, rule overrides) |
| `specbridge verify rules / explain <id>` | **v0.4** — inspect the stable rule registry SBV001–SBV025 |
| `specbridge mcp serve / doctor / manifest / tools` | **v0.5** — local stdio MCP server (30 tools since v0.7.0, 7 resources, 4 prompts) |
| `specbridge run recover-lock` | **v0.5** — diagnose and explicitly recover the interactive execution lock |
| `specbridge runner list / matrix / show / doctor` | **v0.6** — profile-based runner diagnostics and the generated capability matrix (read-only) |
| `specbridge runner test / conformance / models <profile>` | **v0.6** — bounded structured-output probe (`--network`), conformance suite, provider-supported model listing |
| `specbridge config doctor / migrate` | **v0.6** — configuration validation and the explicit v1 → v2 migration (dry-run by default, atomic apply with backup) |
| `specbridge runner doctor gemini-default / openai-compatible-local / antigravity` | **v0.6.1** — diagnostics for the new adapters; MCP `runner_list` / `runner_show` / `runner_doctor` / `runner_matrix` expose the same read-only services |
| `specbridge template list / search / show / validate` | **v0.7.0** — deterministic, offline template discovery and validation (read-only) |
| `specbridge template preview / apply [--dry-run]` | **v0.7.0** — one rendering path; preview writes nothing, apply is atomic and never overwrites |
| `specbridge template install / uninstall / scaffold` | **v0.7.0** — local, script-free pack installation and community-template scaffolding |
| `specbridge spec new <name> --template <ref> --var k=v` | **v0.7.0** — template-based spec creation through the same service |

Planned commands (`spec sync/export`) are registered, marked "(planned)" in
`--help`, and exit with an honest error — see the [roadmap](docs/roadmap.md).
Every command supports `--help` with examples. Exit codes: `0` success ·
`1` workflow/verification failure · `2` usage or configuration error ·
`3` runner unavailable / git comparison unavailable · `4` runner or
verification-command start failure · `5` timeout/cancel · `6` safety
violation ([details](docs/ci-quality-gates.md)).

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
Runner-assisted generation (since v0.3) is always explicit opt-in; offline
templates remain the default.

## Model-assisted authoring and task execution (v0.3, multi-runner since v0.6)

With a locally installed, locally authenticated agent CLI (Claude Code or
Codex), a local Ollama endpoint for authoring, or the offline mock runner,
SpecBridge can draft spec stages and execute approved tasks — with the
safety model doing the real work:

```sh
specbridge runner doctor claude-code
specbridge runner matrix

specbridge spec generate notification-preferences --stage requirements --runner ollama-local
specbridge spec analyze  notification-preferences --stage requirements
specbridge spec approve  notification-preferences --stage requirements

specbridge spec generate notification-preferences --stage design --runner codex-default
specbridge spec approve  notification-preferences --stage design
specbridge spec generate notification-preferences --stage tasks
specbridge spec approve  notification-preferences --stage tasks

specbridge spec run notification-preferences --task 2.3 --runner codex-default
specbridge run show <run-id>
```

How it stays safe (details: [task execution](docs/task-execution.md),
[evidence](docs/execution-evidence.md), [verification](docs/task-verification.md),
[security](docs/security.md)):

- **SpecBridge does not include Claude usage.** You install and authenticate
  Claude Code yourself; SpecBridge only invokes the local executable and
  never stores, proxies, or prints credentials.
- **Model output is never proof.** The repository state is captured before
  and after every run; the model's reported files/tests are stored as
  claims and cross-checked against actual git evidence.
- **Task completion requires evidence.** The checkbox flips only after
  trusted verification commands (from `.specbridge/config.json`, argv
  arrays, never from spec content or model output) pass — or after explicit,
  audited manual acceptance with a reason.
- **Generated stages are never auto-approved**, approved stages are never
  overwritten, and one task runs per invocation (`--all` is sequential and
  stops at the first unverified task).
- **SpecBridge never enables `bypassPermissions`** or any permission-skip
  flag — rejected at three layers — and never commits, pushes, or rolls
  back your repository.

## Claude Code integration

Two directions, both covered in
[docs/claude-code-integration.md](docs/claude-code-integration.md):

- **SpecBridge invokes Claude Code** (v0.3): `spec generate/refine/run` use
  your locally installed, locally authenticated `claude` CLI as a runner —
  see [docs/claude-code-runner.md](docs/claude-code-runner.md).
- **Claude Code drives SpecBridge**: `spec context --target claude-code`
  produces agent-ready context, and a skill wrapping the CLI lives at
  [integrations/claude-code/skills/specbridge](integrations/claude-code/skills/specbridge/SKILL.md).
  The CLI remains the product core; the skill is a thin wrapper that never
  bypasses approval gates or edits checkboxes itself.

## Spec drift verification (v0.4)

The headline differentiator: deterministic, LLM-free verification that
implementation changes still match the approved specs. SpecBridge detects
explicit traceability gaps, stale evidence, approval drift, out-of-scope
file changes, and failed configured verification commands — it does **not**
claim to semantically prove that code implements natural-language
requirements, and findings based on pattern recognition are labelled
heuristic and never default to error.

```sh
specbridge spec verify notification-preferences --working-tree
specbridge spec verify notification-preferences --diff origin/main...HEAD --run-verification
specbridge spec verify --changed --diff origin/main...HEAD
specbridge spec verify --all --working-tree --fail-on warning
specbridge spec affected --diff origin/main...HEAD
```

What it checks (25 stable rule IDs, `specbridge verify rules`):

- **Approval drift** — approved requirements/design/task-plan content that
  changed after approval (SBV002/SBV003). Checkbox-only `[ ]`→`[x]`
  progress no longer invalidates an approved task plan (normalized plan
  hash, v0.4); real plan edits still do.
- **Evidence** — checked tasks without valid evidence, stale evidence
  (spec or task changed after it was recorded), manual acceptance
  labelled distinctly (SBV004/SBV011/SBV015/SBV024).
- **Traceability** — requirements no task references, tasks referencing
  unknown requirements, checked parents with open subtasks
  (SBV007–SBV010).
- **Scope** — changes outside declared impact areas, protected-path
  modifications, files no spec claims (SBV005/SBV006/SBV014/SBV022).
- **Trusted commands** — failed/missing/timed-out verification commands
  from `.specbridge/config.json` (SBV012/SBV013/SBV025) — never from spec
  text or model output.

Reports: terminal, versioned JSON, GitHub-ready Markdown, and a
self-contained HTML file. Verification is read-only — it never edits
`.kiro`, checkboxes, approvals, or evidence. Everything is deterministic
and offline: no model, no API key, no network.

Docs: [spec drift verification](docs/spec-drift-verification.md) ·
[rules](docs/verification-rules.md) · [policies](docs/verification-policy.md) ·
[traceability](docs/requirement-task-traceability.md) ·
[evidence freshness](docs/evidence-freshness.md) ·
[affected specs](docs/affected-spec-detection.md) ·
[CI quality gates](docs/ci-quality-gates.md).

## GitHub Action (v0.4)

A production node20 action wraps the same verification engine — no model,
no API key, no pnpm, no network access:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0            # the action never fetches by itself

- name: Verify spec alignment
  uses: <owner>/specbridge/integrations/github-action@v0.4   # placeholder until published
  with:
    mode: changed
    fail-on: error
    run-verification: true
```

Pull-request and push diffs resolve from the event; `workflow_dispatch`
takes explicit `base-ref`/`head-ref`. The action writes a Step Summary,
emits bounded file/line annotations titled with rule IDs, exposes ten
outputs, and uploads-ready reports land in `.specbridge/action-reports`.
Details: [docs/github-action.md](docs/github-action.md) ·
[integrations/github-action](integrations/github-action/README.md).
CI for this repository runs on Linux, macOS, and Windows with Node 20/22.

## Supported runners

Runners make SpecBridge model- and agent-agnostic. Default commands never
require one. Since v0.6, runners are configured as capability-checked
PROFILES; the live matrix comes from `specbridge runner matrix`:

| Profile | Support | Author | Refine | Execute | Resume | Local |
|---------|---------|--------|--------|---------|--------|-------|
| claude-code | production | yes | yes | yes | yes | no |
| codex-default | production | yes | yes | yes | yes | no |
| gemini-default | production | yes | yes | yes | yes | no |
| ollama-local | production | yes | yes | no | no | yes |
| openai-compatible-local | production | yes | yes | no | no | yes |
| antigravity | experimental | no | no | no | no | no |
| mock | production | yes | yes | yes | yes | yes |

Every non-Claude profile ships DISABLED until you enable it explicitly.
Ollama and OpenAI-compatible endpoints are authoring-only by capability —
they can never execute tasks or modify files. Gemini task execution and
resume are capability-gated: they work only when the installed Gemini CLI
proves a bounded edit policy (auto_edit plus tool allowlist or sandbox)
without arbitrary shell access — YOLO is never used, and an unsafe
installation keeps safe authoring while task execution is refused with the
exact gap. The Antigravity adapter is experimental capability detection
only; it is not a production runner and executes nothing.

Configuration lives in `.specbridge/config.json` (schema 2.0.0; v1 files
stay readable, migration is explicit — see
[docs/configuration-migration.md](docs/configuration-migration.md) and
[docs/runners.md](docs/runners.md)). Never commit API keys; SpecBridge
stores no credentials of any kind.

## Security and privacy

- Default commands are read-only and fully offline; no telemetry, no network.
- Writes are atomic, path-checked against traversal, and confined to the
  workspace; symlinks are never followed out of the repository.
- Spec content and model output are treated as data — never executed as
  shell commands or trusted as instructions.
- Runner execution is always explicit; verification commands come from
  trusted project configuration (argv arrays, no shell), never from model
  output; permission bypasses are rejected at three layers.
- No credentials are ever collected, stored, or printed; logs never include
  secrets or environment variables.
- Full model: [docs/security.md](docs/security.md).

## Limitations (v0.7.0)

- The MCP server is stdio-only and local-only: no HTTP/SSE/WebSocket
  transport, no OAuth, no cloud hosting. One server process serves one
  project root.
- The plugin requires Node.js 20+ on PATH (the same requirement as Claude
  Code) and a Git repository for interactive task execution.
- Interactive execution is strictly one task per run per repository,
  guarded by a lock file; recovery after a crash is explicit
  (`specbridge run recover-lock`), never automatic.
- Claude Code plugin-scoped MCP tool prefixes are host-generated; skills
  reference tools by short name, and the effective prefixes are only
  verifiable inside a real Claude Code session (`/mcp`).

- Verification is deterministic, not semantic: it proves traceability,
  approval, evidence, scope, and command facts — it cannot judge whether
  code *correctly implements* a natural-language requirement, and it never
  claims to. Heuristic findings (test-language detection, keyword
  references, chore-task exclusion) are labelled and never default to error.
- `spec sync` and `spec export` are not implemented yet (they fail
  honestly). SARIF output is deferred.
- Templates are local-only: there is no remote registry, no GitHub/npm/URL
  installation, and no signed packs in v0.7.0. Template rendering is plain
  `{{variable}}` substitution — no expressions, no conditionals, and
  literal double braces are not supported in template files. Rendered
  Markdown can still contain untrusted prose; SpecBridge control rules
  (approvals, protected paths, verification) are never overridable by
  template content.
- Production runners are claude-code, codex-cli, gemini-cli, ollama
  (authoring-only), openai-compatible (authoring-only), and mock; the
  antigravity-cli adapter is experimental detection only. Provider usage
  happens under your own accounts and plans; not every installed provider
  version is compatible (the doctor reports the exact missing
  capabilities). Not every Gemini CLI version supports safe task
  execution, and not every OpenAI-compatible endpoint implements JSON
  Schema or the Responses API — the profile declares what its endpoint
  supports.
- Ollama and OpenAI-compatible endpoints cannot execute tasks or modify
  files — by capability, not by configuration. Models are never pulled or
  selected automatically, and model output never proves implementation
  correctness.
- Codex and Gemini resume need an installed version with explicit session
  resume; without it, resume is reported unsupported instead of guessed.
- Authoring fallback exists only for explicitly configured chains, only for
  stage generation/refinement, with bounded retries; there is no automatic
  provider switching anywhere else.
- Task execution requires a git repository, sidecar workflow state, and
  fully approved stages — by design; there is no force flag.
- Tasks can only auto-verify when verification commands are configured;
  with none configured, runs end `implemented-unverified`.
- One task per run; `--all` is strictly sequential. Parallel execution,
  agent teams, sandboxing, and automatic rollback remain out of scope.
- Verification requires git history: shallow clones fail with actionable
  guidance (SBV021) rather than guessing; SpecBridge never fetches.
- Sidecar state written before v0.4 has no normalized task-plan hash;
  checkbox edits made outside SpecBridge read as stale until the next
  approval or sanctioned write records it (documented migration).
- Evidence recorded by v0.3 lacks `specContext` hashes; freshness then
  falls back to recorded approval timestamps (deterministic but coarser).
- Workflow order cannot be inferred without sidecar state (reported as
  `unknown` — by design); the first approval of an existing Kiro spec infers
  it only when unambiguous.
- Files that are not valid UTF-8 are read best-effort and never edited.
- The GitHub Action needs `fetch-depth: 0` and a checked-out `.kiro`
  workspace; it is not yet published to a marketplace tag (use the
  placeholder path until then).
- Setext (`===` underline) headings are not recognized as section boundaries;
  the bytes are preserved regardless.

## Roadmap

v0.1: read-only compatibility, doctor, listing, context, round-trip proof.
v0.2: offline spec authoring, deterministic analysis, hash-based approvals,
stale-approval detection. v0.3: agent runner contract, the Claude Code local
runner, model-assisted generation/refinement, approved task execution with
git snapshots, trusted verification, append-only evidence, verified-only
checkbox completion, manual acceptance, resumable sessions. v0.4:
deterministic drift verification (rule engine SBV001–SBV025, policies,
affected-spec resolution, evidence freshness, four report formats) and the
production GitHub Action. v0.5: the local stdio MCP server, direct
interactive task execution, and the self-contained Claude Code plugin with
its repository-local marketplace. v0.6.0: the capability-driven runner
platform with a frozen adapter contract, runner profiles and explicit
configuration migration, deterministic selection and bounded authoring
fallback, the conformance framework, and the production Codex CLI and
Ollama (authoring-only) runners. v0.6.1: Gemini CLI, OpenAI-compatible
authoring, Antigravity, MCP runner diagnostics, and the runner-management
Skill. v0.7.0 (this release): the offline template system — versioned
manifests, a restricted deterministic renderer, ten built-in templates,
project-local packs, local installation, scaffolding, MCP template tools,
and the templates Skill. Next — v0.7.1: plugin SDK, extension registry,
community ecosystem. Full detail: [docs/roadmap.md](docs/roadmap.md).

## Documentation

[Architecture](docs/architecture.md) ·
[Kiro compatibility](docs/kiro-compatibility.md) ·
[Spec authoring](docs/spec-authoring.md) ·
[Spec analysis](docs/spec-analysis.md) ·
[Templates](docs/templates.md) ·
[Creating templates](docs/creating-templates.md) ·
[Template manifest](docs/template-manifest.md) ·
[Template rendering](docs/template-rendering.md) ·
[Template installation](docs/template-installation.md) ·
[Template security](docs/template-security.md) ·
[Template contribution guide](docs/template-contribution-guide.md) ·
[Approval workflow](docs/approval-workflow.md) ·
[Sidecar state](docs/sidecar-state.md) ·
[Runners (v0.6)](docs/runners.md) ·
[Runner capabilities](docs/runner-capabilities.md) ·
[Runner profiles](docs/runner-profiles.md) ·
[Runner selection](docs/runner-selection.md) ·
[Runner fallback](docs/runner-fallback.md) ·
[Runner conformance](docs/runner-conformance.md) ·
[Runner adapter contract](docs/runner-adapter-contract.md) ·
[Codex CLI runner](docs/codex-cli-runner.md) ·
[Ollama runner](docs/ollama-runner.md) ·
[Network & data boundaries](docs/network-data-boundaries.md) ·
[Runner security](docs/runner-security.md) ·
[Runner troubleshooting](docs/runner-troubleshooting.md) ·
[Configuration migration](docs/configuration-migration.md) ·
[Agent runners](docs/agent-runners.md) ·
[Claude Code runner](docs/claude-code-runner.md) ·
[Model-assisted authoring](docs/model-assisted-authoring.md) ·
[Task execution](docs/task-execution.md) ·
[Execution evidence](docs/execution-evidence.md) ·
[Task verification](docs/task-verification.md) ·
[Session resume](docs/session-resume.md) ·
[Security](docs/security.md) ·
[Spec drift verification](docs/spec-drift-verification.md) ·
[Verification rules](docs/verification-rules.md) ·
[Verification policy](docs/verification-policy.md) ·
[Traceability](docs/requirement-task-traceability.md) ·
[Evidence freshness](docs/evidence-freshness.md) ·
[Affected specs](docs/affected-spec-detection.md) ·
[GitHub Action](docs/github-action.md) ·
[CI quality gates](docs/ci-quality-gates.md) ·
[Claude Code integration](docs/claude-code-integration.md) ·
[MCP server](docs/mcp-server.md) ·
[MCP tools](docs/mcp-tools.md) ·
[MCP resources](docs/mcp-resources.md) ·
[MCP prompts](docs/mcp-prompts.md) ·
[Interactive task execution](docs/interactive-task-execution.md) ·
[Claude Code plugin](docs/claude-code-plugin.md) ·
[Plugin installation](docs/plugin-installation.md) ·
[Plugin development](docs/plugin-development.md) ·
[Plugin marketplace](docs/plugin-marketplace.md) ·
[Plugin security](docs/plugin-security.md) ·
[Plugin release](docs/plugin-release.md) ·
[CLI/MCP parity](docs/cli-mcp-parity.md) ·
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
