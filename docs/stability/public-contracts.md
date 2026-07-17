# Public contracts (v1.0.0)

This is the complete public contract inventory for SpecBridge v1.0.0. A
surface listed here is covered by the [versioning policy](versioning-policy.md);
anything not listed is internal and may change without notice. Persisted
schema versions are **unchanged** by v1.0.0 — the release changes the
product version, not your on-disk data.

Contract areas:
[CLI](#1-cli) · [Kiro compatibility](#2-kiro-compatibility) ·
[Sidecar state](#3-specbridge-sidecar-state) · [Verification](#4-verification) ·
[Runner platform](#5-runner-platform) · [Templates](#6-templates) ·
[Extensions](#7-extensions) · [MCP](#8-mcp-server) ·
[Claude Code plugin](#9-claude-code-plugin) · [GitHub Action](#10-github-action)

## 1. CLI

### Command tree

| Group | Commands |
| --- | --- |
| (top level) | `doctor` · `setup` (new in 1.0.0) · `compat check` |
| `migrate` (new in 1.0.0) | `status` · `plan` · `apply` · `verify` |
| `state` (new in 1.0.0) | `validate` · `recover` |
| `steering` | `list` · `show <name>` |
| `spec` | `list` · `show <name>` · `context <name>` · `new <name>` · `analyze <name>` · `approve <name>` · `status <name>` · `generate <name>` · `refine <name>` · `run <name>` · `accept-task <name>` · `verify [name]` · `affected` · `policy init\|show\|validate <name>` · `export <name>` · `sync` (planned — registered, honest exit 2) |
| `verify` | `rules` · `explain <rule-id>` |
| `runner` | `list` · `matrix` · `show <profile>` · `doctor [profile]` · `test <profile>` · `models <profile>` · `conformance <profile>` · `requirements` · `select` |
| `config` | `doctor` · `migrate` (deprecated alias, see below) |
| `run` | `list` · `show <run-id>` · `resume <run-id>` · `recover-lock` |
| `mcp` | `serve` · `doctor` · `manifest` · `tools` |
| `template` | `list` · `search <query>` · `show` · `validate` · `preview` · `apply` · `install <local-path>` · `uninstall` · `scaffold <template-id>` |
| `extension` | `list` · `search <query>` · `show` · `validate` · `install <source>` · `enable` · `disable` · `uninstall` · `doctor` · `conformance` · `scaffold <id>` · `package <path>` |
| `registry` | `list` · `add <name>` · `remove <name>` · `update [name]` · `search <query>` · `show <extension>` · `validate` |

New in 1.0.0 alongside the commands above: `doctor --repair-plan`, which
reports what `state recover` / `migrate apply` would do without touching
anything.

### Option conventions

- Global: `-C, --cwd <dir>` (run as if started from `<dir>`), `-V, --version`.
- `--json` on reporting commands switches the entire stdout stream to the
  JSON report envelope (below). Long options are kebab-case.
- Consent is always an explicit flag (`--yes`, `--accept-permissions <hash>`,
  `--dry-run` previews) — never an interactive prompt.

### Exit codes

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | ok | success; no blocking findings |
| 1 | gate failure | findings at or above the failure threshold; a quality gate did not pass |
| 2 | usage error | invalid arguments, unknown command, workspace problems, planned commands |
| 3 | runner unavailable | the selected runner/profile cannot run (missing executable, incompatible) |
| 4 | runner failure | the runner started and failed |
| 5 | timeout | a runner or verification command timed out |
| 6 | safety failure | a safety boundary was violated (e.g. protected path modified) |

Codes 3–6 are produced only by run/execution commands; everything else uses
0/1/2.

### JSON output

With `--json`, stdout carries exactly one pretty-printed envelope:

```json
{ "schema": "specbridge.<name>/<rev>", "generator": "specbridge <version>", "data": { } }
```

Report IDs are stable identifiers; the `/<rev>` suffix is bumped only when
the payload shape changes incompatibly. IDs as of 1.0.0 (all `/1` unless
marked):

| Area | Report IDs (`specbridge.` prefix omitted) |
| --- | --- |
| workspace | `doctor`, `compat-check`, `config-doctor`, `config-migrate` |
| steering | `steering-list`, `steering-show` |
| spec | `spec-list`, `spec-show`, `spec-new`, `spec-analyze`, `spec-approve`, `spec-status`, `spec-affected`, `spec-export`, `spec-generate`, `spec-refine`, `spec-run`, `spec-run-all`, `accept-task` |
| policy / rules | `policy-init`, `policy-show`, `policy-validate`, `verify-rules`, `verify-explain` |
| runner | `runner-list` **/2**, `runner-show` **/2**, `runner-doctor` **/2**, `runner-matrix`, `runner-test`, `runner-models`, `runner-conformance`, `runner-select` |
| run | `run-list`, `run-show`, `run-resume`, `run-recover-lock` |
| mcp | `mcp-doctor`, `mcp-manifest`, `mcp-tools` |
| template | `template-list`, `template-search`, `template-show`, `template-validate`, `template-preview`, `template-apply`, `template-install`, `template-uninstall`, `template-scaffold` |
| extension | `extension-list`, `extension-search`, `extension-show`, `extension-validate`, `extension-install`, `extension-enable`, `extension-disable`, `extension-uninstall`, `extension-doctor`, `extension-conformance`, `extension-scaffold`, `extension-package` |
| registry | `registry-list`, `registry-add`, `registry-remove`, `registry-update`, `registry-search`, `registry-show`, `registry-validate` |

Commands whose primary output is a domain document use that document's own
schema instead of the envelope — `spec verify` writes the verification
report (schemaVersion 1.0.0). The new `migrate`/`state`/`setup` commands
follow the same envelope convention.

### stdout / stderr and non-interactive behavior

- In `--json` mode, stdout contains JSON and nothing else. Human-readable
  warnings, deprecation notices, and hints go to stderr — always.
- No command ever blocks on hidden input. Anything that would need a
  confirmation takes an explicit flag and fails honestly without it. The
  CLI is CI-safe as-is.

### Deprecated aliases

| Deprecated | Replacement | Since | Removal |
| --- | --- | --- | --- |
| `specbridge config migrate` | `specbridge migrate` | 1.0.0 | kept through v1.x; no earlier than v2.0.0 |

The alias keeps working and prints a one-line deprecation warning on stderr
naming the replacement.

### Stability

| | |
| --- | --- |
| Version | CLI 1.0.0 |
| Status | stable (`spec sync` remains planned and exits honestly) |
| Compatibility | documented commands, options, exit codes, and report IDs do not break within v1.x; new commands/options arrive in minors |
| Breaking changes | major releases only, after deprecation |
| Deprecation | stderr warning + documented replacement + removal no earlier than the next major |
| Migration | `specbridge migrate` performs all state/config migrations explicitly; nothing migrates on read |

## 2. Kiro compatibility

`.kiro` is the source of truth and SpecBridge treats it as someone else's
data.

- **Layout** (supported Kiro layout version `'1'`): `.kiro/steering/*.md`
  and `.kiro/specs/<spec>/` with the recognized documents
  `requirements.md`, `design.md`, `tasks.md`, and `bugfix.md`.
- **Byte-identical no-op round trip**: reading and rewriting a `.kiro` file
  without a semantic change reproduces it byte for byte (golden-tested).
- **Unknown-content preservation**: content the tolerant parsers do not
  recognize is preserved exactly, never dropped or reformatted.
- **Task checkbox updates are surgical**: completing a task changes the one
  checkbox character of the one target line — no reflow, no whitespace or
  line-ending changes anywhere else in `tasks.md`.
- **No SpecBridge metadata in `.kiro`**: everything SpecBridge needs lives
  in the [sidecar](#3-specbridge-sidecar-state); `doctor` actively scans
  for violations.

### Stability

| | |
| --- | --- |
| Version | Kiro layout `'1'` |
| Status | stable — the foundational guarantee of the project |
| Compatibility | the round-trip and preservation guarantees hold for every v1.x release; newly recognized filenames would be additive |
| Breaking changes | a new Kiro layout version would be adopted alongside `'1'`, never by dropping it in v1.x |
| Deprecation | not applicable — `.kiro` compatibility is not deprecable |
| Migration | none required, ever; delete `.specbridge/` and the Kiro project is exactly as it was |

## 3. SpecBridge sidecar state

Everything persisted lives under `<workspaceRoot>/.specbridge/`. There is
no global or per-user state anywhere.

| Path (under `.specbridge/`) | Schema family | schemaVersion | Read behavior |
| --- | --- | --- | --- |
| `state/specs/<name>.json` | spec-state | 1.0.0 (accepts 1.x) | tolerant; invalid/legacy degrades to diagnostics (`SIDECAR_STATE_*`), spec treated as unmanaged, `.kiro` wins |
| `config.json` | runner config (v2) | 2.0.0 — v1 (1.0.0) still readable | tolerant reader accepts v1 and v2; upgrade only via explicit migration |
| `policies/<spec>.json` | verification policy | 1.0.0 | **fail-closed**: invalid → secure defaults + SBV020 |
| `evidence/<spec>/<task>/<run-id>.json` | evidence | 1.0.0 | append-only; strict write, tolerant read |
| `runs/<run-id>/run.json`, `events.jsonl`, `attempts/<id>/` | run record / attempt record | 1.0.0 | append-only history, tolerant read |
| `registries.json` | registries | 1.0.0 | tolerant; invalid → builtin-only defaults + diagnostic |
| `registry-cache/<name>.json` | registry cache | 1.0.0 | tolerant; an invalid update never replaces a valid cache |
| `templates/<id>/…` (installed packs) | template manifest | 1.0.0 | strict manifest parse |
| `template-records.jsonl` | template record | 1.0.0 | append-only; bad lines become diagnostics |
| `extensions/state.json`, `grants.json`, `records.jsonl`, `installed/`, `trash/` | extension state | 1.0.0 | tolerant, never silently repaired |
| `reports/…` | verification report / diagnostics | 1.0.0 | opt-in artifacts |
| `locks/interactive-task.lock` | interactive lock | 1.0.0 | runtime lock only |
| `tmp/<unique>/` | — | — | ephemeral staging, removed after use |

**Unknown-field policy.** Machine state (spec state, config, evidence, run
records, registries, cache, extension state, records) passes unknown fields
through, so files written by a newer 1.x release survive a
read-modify-write by an older one. Authored manifests
(`specbridge-template.json`, `specbridge-extension.json`) are strict — a
typo in something a human wrote is an error, not a silent ignore. The
verification policy is the one fail-closed family: an unreadable policy
yields secure defaults plus SBV020, never a silently weaker gate.

Stage approvals in spec state bind to content: `approvedHash` is the
SHA-256 of the exact approved file bytes (the tasks stage additionally
keeps a checkbox-normalized plan hash so `[ ]` → `[x]` is not staleness).

### Stability

| | |
| --- | --- |
| Version | spec-state 1.0.0 · config 2.0.0 (v1 readable) · all other families 1.0.0 — none changed by v1.0.0 |
| Status | stable |
| Compatibility | state written by any v1.x release stays readable by every later v1.x release; optional fields may be added in minors |
| Breaking changes | removing or repurposing a required field requires a schema major + product major |
| Deprecation | superseded schema majors (config v1) stay readable through v1.x with an explicit migration path |
| Migration | explicit only (`specbridge migrate`, `config migrate`); reads never rewrite state |

## 4. Verification

Rule IDs match `/^SBV\d{3}$/`. Stable IDs are never renumbered; a removed
rule leaves a permanent gap.

| ID | Title |
| --- | --- |
| SBV001 | Required spec file missing |
| SBV002 | Spec approval stale |
| SBV003 | Approval prerequisite invalid |
| SBV004 | Completed task lacks verified evidence |
| SBV005 | Changed file outside declared impact area |
| SBV006 | Protected path modified † |
| SBV007 | Requirement has no implementation task |
| SBV008 | Task has no requirement reference |
| SBV009 | Task references unknown requirement |
| SBV010 | Completed parent task has incomplete child task |
| SBV011 | Task evidence is stale |
| SBV012 | Required verification command failed † |
| SBV013 | Required verification command missing † |
| SBV014 | Unmapped changed file † |
| SBV015 | Spec changed after implementation evidence |
| SBV016 | Task marked complete before task-plan approval |
| SBV017 | No test evidence for test-required task |
| SBV018 | Design path reference does not exist |
| SBV019 | Changed file not represented in execution evidence |
| SBV020 | Verification policy invalid |
| SBV021 | Diff base unavailable † |
| SBV022 | Ambiguous affected-spec mapping † |
| SBV023 | Tasks document unexpectedly changed |
| SBV024 | Evidence points outside repository |
| SBV025 | Verification command timed out † |
| SBV026 | Extension verifier reported failure |

† global-scope rules (SBV006, SBV012, SBV013, SBV014, SBV021, SBV022,
SBV025) — they apply to the run, not to a single spec.

- **Schemas**: verification report 1.0.0, diagnostics 1.0.0.
- **Severities**: `error` / `warning` / `info`. Strict mode tightens
  severities, never loosens them.
- **Failure threshold**: `--fail-on error|warning|never`; reaching the
  threshold exits 1 (gate failure).
- **Extension rules**: diagnostics from verifier extensions are namespaced
  `<extension-id>/<RULE>` and can never collide with built-in SBV IDs; an
  extension verifier failing to run is itself SBV026.

### Stability

| | |
| --- | --- |
| Version | rule set SBV001–SBV026 · report/diagnostic schemas 1.0.0 |
| Status | stable |
| Compatibility | rule IDs, meanings, and report schemas hold within v1.x; new rules append new IDs in minors |
| Breaking changes | removing a rule or changing a report schema incompatibly requires a major; removed IDs are never reused |
| Deprecation | a rule slated for removal is documented as deprecated before a major removes it |
| Migration | none — reports are outputs, not migrated state |

## 5. Runner platform

The versioned, capability-driven adapter contract every runner implements.
Orchestration never branches on provider names.

- **Operations** (6): `stage-generation`, `stage-refinement`,
  `task-execution`, `task-resume`, `model-list`, `runner-test`.
- **Categories** (4): `agent-cli`, `model-api`, `mock`, `experimental`.
- **Support levels** (5): `production`, `preview`, `experimental`,
  `unavailable`, `incompatible`. `preview` and `experimental` profiles are
  never selected automatically — explicit selection only.
- **Capability keys** (17, never a single boolean): `stageGeneration`,
  `stageRefinement`, `taskExecution`, `taskResume`,
  `structuredFinalOutput`, `streamingEvents`, `repositoryRead`,
  `repositoryWrite`, `sandbox`, `toolRestriction`, `usageReporting`,
  `costReporting`, `localOnly`, `requiresNetwork`, `supportsSystemPrompt`,
  `supportsJsonSchema`, `supportsCancellation`.
- **Runner kinds**: `mock`, `claude-code`, `codex-cli`, `gemini-cli`,
  `ollama`, `openai-compatible`, `antigravity-cli`, `extension`,
  `unsupported`. Built-in profile names: `claude-code`, `mock`,
  `codex-default`, `gemini-default`, `ollama-local`,
  `openai-compatible-local`, `antigravity`.
- **Normalized events**: 17 event types (`runner.started`,
  `runner.completed`, `session.started`, `turn.started`, `turn.completed`,
  `message.delta`, `message.completed`, `tool.started`, `tool.completed`,
  `tool.failed`, `command.started`, `command.completed`, `file.changed`,
  `plan.updated`, `usage.updated`, `warning`, `error`), flat safe payloads,
  32 KiB per-event ceiling. Hidden reasoning content is never normalized
  into events.
- **Normalized results and usage**: provider-independent result and usage
  records; cost is `provider-reported`, `configured-estimate`, or
  `unavailable` — never computed from hardcoded pricing.

**Normalized error codes** (24):

`runner_not_found` · `runner_disabled` · `runner_incompatible` ·
`executable_not_found` · `endpoint_unreachable` ·
`authentication_required` · `permission_denied` · `sandbox_unavailable` ·
`structured_output_unsupported` · `structured_output_invalid` ·
`model_not_found` · `quota_exceeded` · `rate_limited` · `network_error` ·
`process_failed` · `api_error` · `cancelled` · `timed_out` ·
`output_limit_exceeded` · `repository_diverged` ·
`protected_path_modified` · `verification_failed` ·
`invalid_configuration` · `unsupported_operation`

**Adapter contract version**: the contract is expressed as five
schema-versioned families, all at 1.0.0 — capabilities, events, errors,
normalized result, usage — frozen since v0.6.0 with snapshot tests;
changes since have been additive only.

### Stability

| | |
| --- | --- |
| Version | adapter contract schemas 1.0.0 (capabilities/events/errors/result/usage) |
| Status | stable, except: the Antigravity adapter is **experimental** (detection and diagnostics only) and any `preview`/`experimental` support level is outside the stable guarantee |
| Compatibility | within v1.x the contract only grows additively (new optional fields, new enum values documented as additive) |
| Breaking changes | a breaking adapter-contract change requires a new adapter-contract version and a product major |
| Deprecation | runner kinds/profiles slated for removal are deprecated with a documented replacement first |
| Migration | config v1 → v2 is the historical example: explicit `config migrate`, old config readable throughout |

## 6. Templates

- **Manifest**: `specbridge-template.json`, schema 1.0.0, strict parse.
- **Rendering syntax**: `{{variableName}}` only — two braces, a name
  matching `[a-z][a-zA-Z0-9]*`, two braces. One pass; values inserted
  verbatim and never rescanned; no expressions, conditionals, includes,
  helpers, environment or filesystem access, and no escape syntax for
  literal braces. A malformed or undeclared placeholder is an error
  (SBT016), never silently emitted.
- **Source types**: `builtin` (10 templates embedded at build time),
  `project` (packs installed under `.specbridge/templates/`), and
  `extension` (template-provider extensions, one source per extension).
- **Qualification rules**: qualified references are `builtin:<id>`,
  `project:<id>`, and `extension:<extension-id>/<id>`. An unqualified ID
  resolves only when exactly one source provides it; ambiguity is an error
  that lists the qualified candidates. Built-ins are immutable — a project
  template with a built-in's ID is reachable only by qualified reference.
- **Built-in template IDs** (10): `authentication`, `background-job`,
  `bugfix-regression`, `cli-tool`, `database-migration`,
  `event-driven-service`, `performance-optimization`, `refactoring`,
  `rest-api`, `security-hardening`.
- **Vocabulary**: kind `feature` | `bugfix`; modes `requirements-first` |
  `design-first` | `quick`; variable types `string` | `boolean` |
  `integer` | `enum`; allowed file targets — feature:
  `requirements.md`/`design.md`/`tasks.md`, bugfix:
  `bugfix.md`/`design.md`/`tasks.md`; built-in variables `specName`,
  `title`, `description`, `kind`, `mode`, `generatedDate`. Supported Kiro
  layout `'1'`.
- **Records**: append-only `template-records.jsonl` with record types
  `template-apply`, `template-install`, `template-uninstall`,
  `template-scaffold`.

### Stability

| | |
| --- | --- |
| Version | template manifest and record schemas 1.0.0 |
| Status | stable |
| Compatibility | manifests valid in one v1.x release stay valid in later ones; the rendering engine's restrictions are permanent design constraints, not gaps; built-in template IDs are stable (content may improve) |
| Breaking changes | manifest schema breaks or new rendering semantics require a major |
| Deprecation | a built-in template slated for removal is deprecated before a major removes it |
| Migration | manifest engine ranges widen from `<1.0.0` to `<2.0.0` at v1.0.0; installed packs need no changes |

## 7. Extensions

- **Manifest**: `specbridge-extension.json`, strict, ≤ 256 KiB, schema
  1.0.0. Archive suffix `.specbridge-extension.zip`; checksums schema
  1.0.0.
- **Kinds** (5): `template-provider` (data-only), `analyzer`, `verifier`,
  `exporter`, `runner`.
- **Protocol**: version 1.0.0 — JSON-Lines JSON-RPC 2.0 over stdio,
  ≤ 2 MiB per message. Methods (5): `initialize`,
  `extension.getMetadata`, `extension.invoke`, `extension.cancel`,
  `extension.shutdown`. Error codes: the standard JSON-RPC set (`-32700`,
  `-32600`, `-32601`, `-32602`, `-32603`) plus `-32000` handlerError,
  `-32001` cancelled, `-32002` outputTooLarge, `-32003` notInitialized,
  `-32004` unsupportedOperation, `-32005` invalidOutput.
- **Permission flags**: `specRead`, `repositoryRead`, `repositoryWrite`,
  `network`, `childProcess`, plus `environmentVariables[]` (explicit
  names only, ≤ 16, `/^[A-Z][A-Z0-9_]{0,127}$/`). Extensions install
  disabled; enabling requires accepting the exact grant hash — a SHA-256
  over the canonical `{extensionId, extensionVersion, manifestSha256,
  normalized permissions}`. Any change invalidates the grant.
- **Registry schema**: `registries.json` (schema 1.0.0; source kinds
  `builtin`, `local-file`, `https`; max 20 sources) and the registry index
  (schema 1.0.0, ≤ 5 MiB, strict entries with id/kind/versions, https-only
  URLs, per-archive SHA-256). Cached indexes (schema 1.0.0) carry a
  content hash; an invalid update never replaces a valid cache. A registry
  is a metadata index only — listing is not endorsement, and checksums
  prove integrity, not publisher identity.
- **Namespaced diagnostics**: extension-produced rules and diagnostics are
  namespaced `<extension-id>/<RULE>`; extension-lifecycle diagnostics use
  stable `SBE###` codes (SBE003, SBE004, SBE005, SBE007, SBE008, SBE012,
  SBE014, SBE021); registry diagnostics use `SBR###` codes (SBR001,
  SBR003, SBR004 — network refusal, SBR007).
- **Hard limits** (not permissions, invariants): extensions can never
  approve stages, mark tasks complete, alter evidence, or disable built-in
  protected-path rules.

### Stability

| | |
| --- | --- |
| Version | SDK 1.0.0 · manifest 1.0.0 · protocol 1.0.0 · checksums 1.0.0 · registry index 1.0.0 |
| Status | stable, with a documented limitation: out-of-process isolation and permission declarations are safety and audit boundaries, **not an OS sandbox** |
| Compatibility | extensions built against protocol 1.0.0 keep working across v1.x; engine ranges widen to `<2.0.0` at v1.0.0 |
| Breaking changes | a breaking protocol change ships as a new protocol version, never as an in-place edit of 1.0.0 |
| Deprecation | protocol methods/fields are deprecated with a replacement before any major removes them |
| Migration | none required for v1.0.0; installed extensions and grants are untouched |

## 8. MCP server

- **Identity**: server name `specbridge` (title "SpecBridge"), version
  1.0.0. Local stdio transport only; official SDK pinned at 1.29.0;
  protocol baseline 2025-11-25; Node ≥ 20.

**Tools** (37 — 30 read-only, 7 write-capable):

| Group | Tools |
| --- | --- |
| workspace / steering | `workspace_detect`, `steering_list`, `steering_read` |
| spec (read) | `spec_list`, `spec_read`, `spec_status`, `spec_context`, `spec_analyze`, `spec_affected`, `spec_check_drift`, `spec_stage_validate` |
| tasks / runs (read) | `task_list`, `task_next`, `run_list`, `run_read` |
| runner (read) | `runner_list`, `runner_show`, `runner_doctor`, `runner_matrix` |
| template (read) | `template_list`, `template_search`, `template_show`, `template_preview` |
| extension / registry (read) | `extension_list`, `extension_search`, `extension_show`, `extension_doctor`, `registry_list`, `registry_search`, `registry_show` |
| **write-capable** | `spec_create`, `template_apply`, `spec_stage_apply`, `spec_run_verification`, `task_begin`, `task_complete`, `task_abort` |

**Resources** (7 URI templates): `specbridge://workspace` ·
`specbridge://steering/{name}` ·
`specbridge://specs/{specName}/{document}` ·
`specbridge://specs/{specName}/status` ·
`specbridge://specs/{specName}/context` · `specbridge://runs/{runId}` ·
`specbridge://verification/rules`

**Prompts** (4): `specbridge-status`, `specbridge-author-stage`,
`specbridge-implement-task`, `specbridge-verify`

**Error codes** (SBMCP001–SBMCP020):

| Code | Meaning | Code | Meaning |
| --- | --- | --- | --- |
| SBMCP001 | workspace not found | SBMCP011 | run not found |
| SBMCP002 | invalid tool input | SBMCP012 | run state invalid |
| SBMCP003 | spec not found | SBMCP013 | repository diverged |
| SBMCP004 | stage not applicable | SBMCP014 | verification failed |
| SBMCP005 | approval stale | SBMCP015 | protected path modified |
| SBMCP006 | approval required | SBMCP016 | candidate analysis failed |
| SBMCP007 | task not found | SBMCP017 | current document hash mismatch |
| SBMCP008 | task already complete | SBMCP018 | input too large |
| SBMCP009 | dirty working tree | SBMCP019 | output too large |
| SBMCP010 | interactive run already active | SBMCP020 | internal runtime failure |

### Stability

| | |
| --- | --- |
| Version | server 1.0.0 · SDK 1.29.0 pinned · protocol baseline 2025-11-25 |
| Status | stable (stdio transport only; remote transports are explicitly not planned) |
| Compatibility | stable tool names are never silently renamed; tool/resource/prompt additions arrive in minors; error codes are stable |
| Breaking changes | removing or incompatibly changing a tool requires deprecation first and a major |
| Deprecation | a deprecated tool keeps working and is documented with its replacement until the next major |
| Migration | none — the server is stateless over the same sidecar contracts |

## 9. Claude Code plugin

- **Plugin ID**: `specbridge` (from the plugin's
  `.claude-plugin/plugin.json`).
- **Marketplace ID**: `specbridge-plugins` (repo-root
  `.claude-plugin/marketplace.json`), listing the `specbridge` plugin.
- **Skills** (11), invoked as `/specbridge:<name>`: `approve` (human-only
  by design), `author`, `continue`, `doctor`, `extensions`, `implement`,
  `new`, `runners`, `status`, `templates`, `verify`.
- **Bundled CLI paths**: `bin/specbridge` (POSIX) and `bin/specbridge.cmd`
  (Windows) wrapping `dist/cli.cjs`; the MCP server at
  `dist/mcp-server.cjs`; `dist/checksums.json` for artifact integrity;
  license material in `LICENSE`, `NOTICE.md`, and
  `dist/THIRD_PARTY_LICENSES.txt`.
- **MCP server configuration** (`.mcp.json`): one server keyed
  `specbridge`, launched as
  `node ${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.cjs --stdio --project-root
  ${CLAUDE_PROJECT_DIR}`. Tool names as surfaced inside Claude Code carry
  the host-generated plugin prefix; the underlying short names are the MCP
  tool names above.

### Stability

| | |
| --- | --- |
| Version | plugin 1.0.0 · marketplace entry 1.0.0 |
| Status | stable |
| Compatibility | plugin ID, marketplace ID, skill names, bundled paths, and the MCP server key hold within v1.x; new skills arrive in minors |
| Breaking changes | renaming or removing a skill or bundled entry point requires a major |
| Deprecation | a superseded skill is kept and documented with its replacement until the next major |
| Migration | reinstalling the plugin is always sufficient; the plugin stores nothing outside the workspace sidecar |

## 10. GitHub Action

`integrations/github-action` — a node20 action bundling the same
deterministic verification engine as `spec verify`. No model, no API key,
no network access, no pnpm required at run time.

**Inputs**:

| Input | Default | Notes |
| --- | --- | --- |
| `mode` | `changed` | `single`, `changed`, or `all` |
| `spec` | `''` | required when `mode: single` |
| `base-ref` | `''` | explicit base ref; overrides event resolution; required for `workflow_dispatch` |
| `head-ref` | `''` | explicit head ref (defaults to `HEAD` when `base-ref` is set) |
| `fail-on` | `error` | `error`, `warning`, or `never` |
| `strict` | `'false'` | tightens, never loosens, spec policies |
| `run-verification` | `'true'` | run trusted commands from `.specbridge/config.json` |
| `report-directory` | `.specbridge/action-reports` | workspace-relative; `..` rejected |
| `annotations` | `'true'` | emit file/line annotations |
| `write-step-summary` | `'true'` | Markdown report into the Step Summary |
| `annotation-limit` | `'50'` | 0–1000; excess findings summarized |

**Outputs** (10): `result` (`passed`/`failed`), `verification-id`,
`spec-count`, `error-count`, `warning-count`, `info-count`, `json-report`,
`markdown-report`, `html-report` (workspace-relative paths),
`affected-specs` (JSON array string).

**Report files**: JSON, Markdown, and self-contained HTML reports written
under `report-directory` — the only files the action ever writes.

**Failure behavior**: the step fails when the `fail-on` threshold is
reached, a policy is invalid, the comparison range cannot be resolved
(including shallow clones — the action never fetches; SBV021 with
guidance), or a required command fails to start or times out — always with
the reason in the failure message. Annotations are bounded by
`annotation-limit`; the report artifacts always contain everything. The
action never modifies tracked project files.

### Stability

| | |
| --- | --- |
| Version | action 1.0.0 (node20) |
| Status | stable |
| Compatibility | input and output names, defaults, and failure semantics hold within v1.x; new inputs/outputs are additive with safe defaults |
| Breaking changes | renaming/removing an input or output, or changing a default incompatibly, requires a major |
| Deprecation | a deprecated input keeps working with a run-log warning until the next major |
| Migration | pin a major tag; moving between v1.x tags requires no workflow changes |
