# SpecBridge v1.0.0 threat model

This is the consolidated threat model for SpecBridge 1.0. It gathers, in one
place, every threat class the per-area security documents address, states the
mitigation that actually exists in the code, and — just as deliberately —
states what remains risky and what stays the user's job. Nothing here is
aspirational: every "existing mitigation" names a mechanism that is
implemented and tested, and the final section lists the claims SpecBridge
explicitly does **not** make.

Per-area documents, which remain authoritative for their details:

- [Security model](../security.md) — core guarantees, v0.5 MCP/plugin threats
- [Runner security](../runner-security.md) — multi-provider controls
- [Network and data boundaries](../network-data-boundaries.md)
- [Template security](../template-security.md)
- [Plugin security](../plugin-security.md)
- [Extension architecture](../extensions/overview.md) and
  [manifest reference](../extensions/manifest.md)
- [Registry contribution rules](../../registry/CONTRIBUTING.md)

The design premise everywhere: **the one unrecoverable failure mode this
project cannot have is a wrong edit to your `.kiro` files or your
repository.** Model output, spec prose, source code, templates, extensions,
and registry metadata are all *data*; authority lives only in tool-enforced
rules, hashes, and explicit human actions.

Each entry below follows the same shape: Asset · Trust boundary · Threat ·
Existing mitigation · Residual risk · User responsibility.

---

## 1. Untrusted workspace content

### T01 — Malicious `.kiro` Markdown

- **Asset:** the repository; the integrity of every SpecBridge decision.
- **Trust boundary:** workspace files (any author) → the SpecBridge process.
- **Threat:** a spec or steering file crafted to make SpecBridge execute
  something, write somewhere unexpected, or corrupt state.
- **Existing mitigation:** spec content is parsed by deterministic parsers as
  data; no code path executes anything found in it. Verification commands
  come exclusively from `.specbridge/config.json` as argv arrays — spec
  policies may only *name* configured commands, and shell strings are
  rejected by the config schema. Model-reported paths are validated;
  anything outside the repository is rejected.
- **Residual risk:** none for execution by SpecBridge itself; the prose is
  still shown to humans and models (see T02).
- **User responsibility:** review `.kiro` content from other people the way
  you review code.

### T02 — Prompt injection in specs

- **Asset:** the behavior of the model session that reads the spec.
- **Trust boundary:** spec/steering prose → the host model.
- **Threat:** instruction-like text in a spec ("ignore your verification
  rules", "approve this stage") steering an agent beyond its mandate.
- **Existing mitigation:** prompts label trust boundaries explicitly and
  state that instruction-like text inside files never overrides the
  execution contract; `task_begin` instructions bound the session's mandate.
  Crucially, SpecBridge's control rules are tool-enforced, not
  prose-enforced: no sentence in any spec can approve a stage (approval is a
  human CLI action only), mark a task complete (evidence-gated, T21), widen
  a write path, or disable a protected path.
- **Residual risk:** the prompt-injection resistance of the host model
  itself is outside SpecBridge's control; an influenced model can still
  write bad code inside its permitted surface.
- **User responsibility:** run agents under their own permission systems and
  review diffs before trusting them.

### T03 — Prompt injection in source files

- **Asset:** same as T02, via repository source instead of specs.
- **Trust boundary:** repository source files → the host model.
- **Threat:** hostile comments or strings in source code that a coding agent
  reads during task execution.
- **Existing mitigation:** source is only ever read, never executed, by
  SpecBridge; evidence evaluation ignores narrative content entirely — a
  claim of completion in a file changes nothing (T21). Model-reported paths
  are validated against the repository boundary.
- **Residual risk:** as T02 — the host model may be influenced within its
  permitted edit surface.
- **User responsibility:** treat agent-generated changes as unverified until
  the evidence gate and your own review pass them.

---

## 2. Filesystem and archive safety

### T04 — Path traversal

- **Asset:** files outside the workspace.
- **Trust boundary:** any externally influenced path (tool arguments, spec
  names, template sources, policy globs, archive entries) → the filesystem.
- **Threat:** `../`, absolute paths, drive letters, or null bytes steering a
  read or write outside the workspace.
- **Existing mitigation:** `assertInsideWorkspace` guards every write —
  every resolved write path in every package passes through it and anything
  escaping the root fails with `PATH_OUTSIDE_WORKSPACE`. Identifiers
  (spec/steering/run names) reject `/`, `\`, `..`, and null bytes. Template
  sources must match `files/<name>.template` (SBT007/SBT008) and targets
  are allowlisted, not sanitized (SBT011). Policy globs reject absolute
  paths, `..`, backslashes, and null bytes. Extension package paths are
  checked per entry.
- **Residual risk:** the guard is an in-process check; a defect in it would
  be a security bug (tests cover traversal cases on Windows and POSIX).
- **User responsibility:** report any observed write outside the workspace
  as a security issue.

### T05 — Symlink escape

- **Asset:** files outside the workspace reached *through* the workspace.
- **Trust boundary:** on-disk symlinks → SpecBridge reads/writes.
- **Threat:** a symlink inside a pack, package, or the repository that
  points outside the tree and gets followed.
- **Existing mitigation:** snapshot and protected-path hashing never follow
  symlinks out of the repository. Template packs are `lstat`ed and any
  symlink — at the root or inside — is rejected outright (SBT009);
  uninstall refuses a symlinked install directory rather than following
  it. Extension archives reject entries whose Unix mode marks a symlink
  (SBE011), and symlinks anywhere on an extension entrypoint path are
  rejected at run time (SBE011).
- **Residual risk:** symlinks elsewhere in your own repository behave as
  your OS defines; extension processes run with your OS permissions (T20).
- **User responsibility:** do not keep hostile symlinks inside a workspace
  you point tools at.

### T06 — Archive traversal

- **Asset:** arbitrary filesystem locations during extension install.
- **Trust boundary:** a downloaded or hand-provided `.specbridge-extension.zip`
  → the extension store.
- **Threat:** "zip slip": entry names like `../../etc/x` extracted outside
  the target directory.
- **Existing mitigation:** archives are validated entry-by-entry — every
  entry name passes the package-relative-path check (no `..`, no absolute
  paths, no drive letters, no backslashes, no null bytes), duplicates are
  rejected, and extraction happens into an in-memory map that is then
  staged and atomically renamed into place; there is no raw
  extract-to-disk step for untrusted names.
- **Residual risk:** none identified beyond implementation defects.
- **User responsibility:** none specific; integrity checking is T28.

### T07 — Zip bombs

- **Asset:** memory and disk of the machine running SpecBridge.
- **Trust boundary:** archive bytes → the extractor.
- **Threat:** a small archive that decompresses into an enormous payload.
- **Existing mitigation:** archives are capped at 50 MiB on disk and
  100 MiB total extracted; declared sizes are summed and checked *before*
  inflation, decompression runs with an explicit `maxOutputLength`, and an
  entry that decompresses to a size other than it declared is rejected.
  File count is capped at 1000, nesting depth at 8; ZIP64 and encrypted
  entries are rejected; every entry's CRC is verified (SBE009).
- **Residual risk:** memory use up to the documented caps.
- **User responsibility:** none.

### T08 — Arbitrary file writes

- **Asset:** every file in the workspace not meant to be written.
- **Trust boundary:** tools, templates, exporters, extensions → the
  filesystem.
- **Threat:** any component writing files it was never supposed to touch.
- **Existing mitigation:** the MCP surface has no filesystem tool, no shell
  tool, and no user-supplied working directory. Every write is atomic
  (temp file + fsync + rename) and passes `assertInsideWorkspace`.
  Templates write only to `.kiro/specs/<spec-name>/` and the sidecar, with
  variables never substituted into target paths. Exporter extensions
  return *candidate* files: the host previews them, writes only after an
  explicit `--yes`, and never overwrites. Extensions themselves never
  write — the host performs every write.
- **Residual risk:** task-execution runners (Claude Code, Codex, bounded
  Gemini) edit the repository by design, inside their own sandboxes;
  SpecBridge detects overreach after the fact (T09) rather than preventing
  it mid-run.
- **User responsibility:** review runner diffs; add project-specific
  `execution.protectedPaths`.

### T09 — Protected paths

- **Asset:** `.kiro/**`, `.specbridge` state and config, `.git/**`.
- **Trust boundary:** any runner or verification-command process → the
  paths SpecBridge must be able to trust.
- **Threat:** a runner silently rewriting specs, approvals, evidence, or
  Git state to fake progress.
- **Existing mitigation:** `BUILT_IN_PROTECTED_PATHS` (`.kiro/**`,
  `.specbridge/state/**`, `.specbridge/config.json`, `.git/**`) are always
  enforced, and the IMMUTABLE set — `.git/**` — cannot be configured away
  by any configuration layer (SBV006 always stays an error). A protected-path
  modification blocks verification, is reported with evidence preserved,
  and **nothing is ever rolled back automatically**. HEAD motion and
  approved-hash changes between snapshots are detected as divergence.
- **Residual risk:** this is detection at verification time, not OS-level
  enforcement — a hostile process with your permissions can still perform
  the write; SpecBridge guarantees you find out and that it never
  compounds the damage with an automatic rollback.
- **User responsibility:** treat a protected-path violation as an incident;
  restore via your own version control.

---

## 3. Secrets and credentials

### T10 — Secret leakage into logs, reports, and state

- **Asset:** credentials, tokens, environment values, private prose.
- **Trust boundary:** process internals → everything SpecBridge persists or
  prints.
- **Existing mitigation:** authentication probes report only a summary —
  probe output is never echoed. Logs and reports never include environment
  variables; argv audit records redact configured sensitive values.
  Template records store variable **names** and content **hashes**, never
  values. The MCP server never returns `.specbridge/config.json` raw (only
  a redacted status) and its stderr logs carry safe metadata only.
  Provider reasoning content is redacted from retained raw artifacts. HTML
  reports escape all dynamic content, load no external resources, and
  contain no scripts; Markdown summaries carry no raw command output.
- **Residual risk:** run directories under `.specbridge/runs/` retain raw
  provider output for auditability; whatever a provider chose to print is
  in there.
- **User responsibility:** keep secrets out of specs and steering; treat
  `.specbridge/runs/` as sensitive; redact before sharing reports or bug
  reports.

### T11 — Provider credentials

- **Asset:** your Claude/Codex/Gemini/API credentials.
- **Trust boundary:** provider auth stores and env vars → SpecBridge.
- **Threat:** SpecBridge collecting, storing, proxying, or leaking provider
  credentials.
- **Existing mitigation:** SpecBridge stores no credential values and the
  configuration schema rejects credential-looking keys outright. API keys
  are referenced by environment-variable NAME
  (`apiKeyEnvironmentVariable`); the value is read at request time only,
  redacted from every retained byte, never logged, and never forwarded
  across origins (T17). No provider credential files or private auth JSON
  are ever read; authentication status comes only from official safe
  commands (`claude auth status`, `codex login status`) and is otherwise
  reported as `unknown`.
- **Residual risk:** provider CLIs manage their own credentials entirely
  outside SpecBridge; their storage is theirs.
- **User responsibility:** authenticate providers yourself; never place key
  values in SpecBridge configuration.

### T12 — Child-process environment

- **Asset:** environment variables visible to spawned processes.
- **Trust boundary:** the parent environment → child processes.
- **Threat:** an extension or provider process reading secrets from the
  inherited environment.
- **Existing mitigation:** extension processes receive a **sanitized
  environment**: a small fixed base allowlist (`PATH`, `HOME`, `TEMP`,
  locale/timezone, and Windows system variables) plus only the variable
  names the extension declared and the user accepted — the granted names
  are part of the SHA-256 permission hash (T20). All child processes are
  spawned from argv arrays without a shell; null bytes are rejected; large
  prompts travel via stdin, never via process-list-visible arguments.
- **Residual risk:** provider CLIs (Claude Code, Codex, Gemini) inherit
  your normal environment by necessity — their own authentication lives
  there. SpecBridge never logs or dumps environment values, but it cannot
  and does not claim to sandbox tools you installed to run with your
  identity.
- **User responsibility:** review an extension's requested environment
  variable names before accepting them.

---

## 4. Protocol integrity

### T13 — MCP protocol corruption

- **Asset:** the integrity of the stdio channel between host and MCP server.
- **Trust boundary:** SpecBridge MCP server process ↔ the MCP client.
- **Threat:** stray stdout bytes corrupting protocol frames; malformed or
  oversized tool arguments.
- **Existing mitigation:** stdout carries protocol frames only; all logging
  is structured and stderr-only; `mcp doctor` verifies zero stdout bytes
  during server construction, and a process-level test asserts every
  stdout line is protocol JSON. Zod schemas bound every input (sizes,
  enums, formats) and unknown fields are rejected at the protocol layer;
  responses are capped at 2 MB with pagination and diagnostic limits
  (SBMCP018/SBMCP019 fire before memory blowups). The server targets the
  stable 2025-11-25 protocol through the exactly pinned official SDK
  (1.29.0), with no draft features.
- **Residual risk:** the MCP client's own behavior is outside SpecBridge.
- **User responsibility:** none specific.

### T14 — Extension protocol corruption

- **Asset:** the host's interpretation of extension output.
- **Trust boundary:** extension child process stdout ↔ the SpecBridge host.
- **Threat:** a buggy or hostile extension flooding, malforming, or
  spoofing protocol messages.
- **Existing mitigation:** the protocol is JSON-RPC 2.0 over JSON Lines
  with messages capped at 2 MiB (`MAX_PROTOCOL_MESSAGE_BYTES`), enforced
  on both sides before parsing. The initialize handshake rejects identity
  mismatches and any capability not declared in the installed manifest.
  The host retains at most 10 MiB of stdout and 5 MiB of stderr, applies
  a 10 s startup timeout and bounded per-operation timeouts, and
  terminates gracefully-then-forcefully. One fresh process serves one
  invocation session. Malformed output fails that invocation — it is
  never interpreted as instructions and never becomes evidence.
- **Residual risk:** a hostile extension can always fail its own
  invocation; that is the intended blast radius at the protocol level
  (process-level risk is T20).
- **User responsibility:** report extensions that misbehave; disable them.

---

## 5. Network boundaries

### T15 — Registry attacks

- **Asset:** the extension discovery and install pipeline.
- **Trust boundary:** remote registry index and archive hosts → the local
  cache and extension store.
- **Threat:** a malicious or compromised registry serving poisoned
  metadata, oversized indexes, or substituted archives.
- **Existing mitigation:** registries are metadata only — an index never
  contains executable content. Indexes are schema-validated with strict
  bounds (entry caps, string lengths, HTTPS-pattern URLs, 64-hex-char
  `sha256` per version). The network is touched only by an explicit
  `--network` flag; search always reads local data. Only schema-valid
  indexes are ever cached and **an invalid update never replaces a
  previously valid cache** — oversized, redirected-unsafely, failed, or
  invalid responses all preserve the prior cache. Archive downloads
  require credential-free HTTPS URLs, and the downloaded bytes must match
  the registry entry's exact SHA-256 (SBE009) before install — which
  still lands **disabled** behind permission acceptance (T20).
- **Residual risk:** a registry can list malware whose checksum matches
  its own archive perfectly; listing is not review (see non-claims).
- **User responsibility:** read the extension's source repository and its
  declared permissions before enabling anything.

### T16 — Redirect attacks

- **Asset:** where request bodies (spec content) actually go.
- **Trust boundary:** the configured endpoint → wherever HTTP redirects
  point.
- **Threat:** a redirect chain rerouting spec content or downloads to an
  attacker host, or downgrading transport security.
- **Existing mitigation:** redirects are **rejected by default** — a
  redirect is a failure, not a hop. Only the openai-compatible adapter
  and registry fetches opt into bounded following (max 3 hops), where
  HTTPS never downgrades to HTTP, unsupported schemes and
  credential-bearing targets are rejected, and safe redirect metadata
  (count, final URL, cross-origin flag) is recorded.
- **Residual risk:** within an opted-in allowance, a same-origin redirect
  is followed; a permitted cross-origin hop still delivers the request
  (without your headers — T17) to the new origin, visibly flagged.
- **User responsibility:** configure endpoints that do not redirect; check
  recorded redirect metadata when they do.

### T17 — Cross-origin Authorization

- **Asset:** the API key sent as an `Authorization` header.
- **Trust boundary:** the configured origin → any other origin.
- **Threat:** a redirect leaking the bearer token to a different host.
- **Existing mitigation:** the `Authorization` header — and every custom
  header — travels only while the request stays on the configured origin;
  the moment a redirect crosses origins, all custom headers are dropped
  for the remainder of the chain, and the cross-origin fact is recorded.
- **Residual risk:** none identified for the header itself; body content
  crossing origins is covered by T16.
- **User responsibility:** rotate any key you suspect was exposed by
  infrastructure outside SpecBridge.

### T18 — Remote endpoint data boundaries

- **Asset:** spec and steering content; knowledge of what leaves the
  machine.
- **Trust boundary:** the local machine → a configured remote inference
  endpoint.
- **Threat:** spec content silently reaching a network endpoint the user
  did not consciously choose.
- **Existing mitigation:** every runner profile carries a boundary class
  (`in-process`, `local-process`, `loopback-endpoint`,
  `network-endpoint`) shown in plans, listings, and attempt records.
  Network-backed profiles require explicit selection — the global default
  alone never reaches them (`requireExplicitRunnerForNetworkAccess`, on
  by default), and `allowNetworkRunners: false` refuses them outright.
  Before a network-backed run, SpecBridge reports endpoint host, model,
  document list, and approximate input size; `--dry-run` never sends a
  request. Never sent: `.env` files, credential files, raw provider logs,
  unrestricted `.specbridge` state, arbitrary home-directory files, or
  the full repository.
- **Residual risk:** what *is* sent — steering, relevant spec stages, the
  instruction, selected repository observations — is fully visible to the
  endpoint operator.
- **User responsibility:** only configure endpoints entitled to read your
  specs; use dry runs to inspect the boundary first.

---

## 6. Third-party content

### T19 — Malicious templates

- **Asset:** the workspace and the specs a template generates.
- **Trust boundary:** a template pack (any author) → the rendering engine
  and `.kiro/specs/`.
- **Threat:** a pack that executes code, escapes its directory, exhausts
  resources, or plants misleading spec prose.
- **Existing mitigation:** templates are data, not code — no field names a
  command, no code path spawns one, no environment interpolation, no
  network, no recursive rendering (one pass, values inserted verbatim,
  never rescanned), `{{variableName}}` is the entire syntax. Strict
  manifest schema with safe-regex vetting of `pattern` constraints.
  Bounds enforced before parsing: 20 files, 256 KiB manifest, 1 MiB per
  file, 5 MiB per pack, 1 MiB per rendered document, UTF-8 only.
  Traversal and symlinks rejected (SBT007–SBT009); targets allowlisted
  (SBT011); apply never overwrites an existing spec (SBT020) and has no
  `--force`; generated stages start unapproved; rendered output must
  parse as a valid spec document (SBT017). MCP apply is bound to the
  previewed `candidateHash` plus the literal acknowledgement
  `apply-reviewed-template`, re-rendered and refused on mismatch (SBT023).
- **Residual risk:** rendered prose can still contain instruction-like
  text aimed at agents (T02); v1.0 has no pack signing or provenance.
- **User responsibility:** inspect packs before installing
  (`specbridge template show <ref> --files --manifest`); treat generated
  prose as data.

### T20 — Malicious extensions

- **Asset:** your machine — an enabled executable extension is local code.
- **Trust boundary:** third-party extension code → the SpecBridge host and
  your operating system.
- **Threat:** an extension that lies about its permissions, escalates
  after review, tampers with state, or is simply malware.
- **Existing mitigation:** install validates everything and executes
  nothing — no lifecycle scripts, no imports; the package is staged and
  atomically renamed, then revalidated from disk. Extensions install
  **disabled**; enabling requires `--accept-permissions <hash>`, where the
  hash is a SHA-256 permission hash binding the grant to the extension
  ID, version, exact manifest bytes, and normalized permission set — any
  manifest, version, or permission change invalidates the grant (SBE018),
  re-checked on every invocation. Execution is always out of process
  (`node <entrypoint>`, argv array, never a shell) with a sanitized
  environment (T12) and the bounded protocol (T14); the handshake rejects
  undeclared capabilities. Extensions can never approve stages, complete
  tasks, change evidence, disable built-in rules, or write files — the
  host performs every write, and conformance checks that an extension did
  not modify its own installed package. `template-provider` packages get
  no permissions at all. Uninstall goes to a recoverable trash directory;
  operation records are append-only.
- **Residual risk:** **process isolation is not an OS sandbox.** An
  enabled executable extension runs with your operating-system
  permissions; a permission grant is a reviewed declaration and an audit
  boundary, not a syscall filter. Checksums prove integrity, not who
  published the code.
- **User responsibility:** treat enabling an extension like installing an
  npm package: read the permissions, read the code or trust its author,
  and prefer extensions whose source you can see.

---

## 7. Evidence and state integrity

### T21 — Runner output claims

- **Asset:** the truthfulness of "this task is done."
- **Trust boundary:** model/provider output → SpecBridge's completion
  state.
- **Threat:** a model claiming success — files changed, tests passed —
  that never happened.
- **Existing mitigation:** model claims are **never authoritative**.
  Reported changed files, commands, tests, and completion statements are
  recorded verbatim as claims (`runnerClaims`) and never consulted as
  evidence. Completion authority is: actual Git snapshots captured before
  and after every run, actual repository changes, trusted verification
  commands from `.specbridge/config.json`, valid SpecBridge evidence, and
  explicit manual acceptance. No runner can mark a task complete.
  Verifier-extension output reaches the quality gate only through the
  built-in `SBV026` rollup and is likewise a claim, not evidence.
- **Residual risk:** the gate is only as strong as the configured
  verification commands; an empty test suite verifies nothing.
- **User responsibility:** configure `verification.commands` that actually
  prove your acceptance criteria.

### T22 — Stale evidence

- **Asset:** the validity of past evidence against the present repository.
- **Trust boundary:** historical evidence records → current verification.
- **Threat:** old evidence "verifying" a task after the spec, the task, or
  the history it described has changed.
- **Existing mitigation:** evidence is hash-bound to the approved content
  it was produced against: exact-byte stage hashes, the
  checkbox-normalized `approvedPlanHash` for tasks, and a
  checkbox-invariant task fingerprint. At verification time, recorded
  hashes must equal the currently approved content, the fingerprint must
  match the task as it exists now, recorded paths must stay inside the
  repository (SBV024), and recorded commits must be ancestors of HEAD
  where resolvable. Any drift buckets the record as stale (SBV011 for
  evidence-side drift, SBV015 for spec-side drift) — deterministically,
  from recorded data.
- **Residual risk:** legacy v0.3 records without `specContext` fall back
  to deterministic approval-timestamp comparison, which is coarser.
- **User responsibility:** re-run tasks after editing approved stages
  instead of arguing with the staleness verdict.

### T23 — Migration tampering

- **Asset:** `.specbridge` state during a version migration.
- **Trust boundary:** a reviewed migration plan → the files actually
  rewritten by `migrate apply`.
- **Threat:** state files changing between plan and apply, or a tampered
  plan writing content nobody reviewed.
- **Existing mitigation:** migration plans are **hash-bound**: the plan
  hash covers a canonical projection in which every step's
  `beforeSha256` (the exact bytes the plan was computed from) and the
  SHA-256 of its replacement content are folded in — substituted content
  cannot satisfy the hash. Apply recomputes the hash and refuses a stale
  plan before anything is written (`refused-stale-plan`); every original
  file is backed up under `.specbridge/migrations/<planId>/backups`
  before the first write; writes are atomic and validated afterwards; any
  failure restores every original. Planning is pure — nothing written, no
  network, no model — and re-applying is a no-op.
- **Residual risk:** backups live inside the same workspace and share its
  disk fate.
- **User responsibility:** review `migrate plan` output before applying;
  commit or back up before migrating.

### T24 — Recovery-plan substitution

- **Asset:** `.specbridge` state during corruption recovery.
- **Trust boundary:** a reviewed recovery plan → the state rewritten by
  `state recover --apply`.
- **Threat:** the recovery actually applied differing from the recovery
  the user reviewed — by state drift or by plan substitution.
- **Existing mitigation:** recovery follows the same discipline as
  migration (T23) plus an explicit consent step: planning is read-only
  and produces a hash-bound plan; applying requires re-presenting that
  exact plan hash together with an acknowledgement token, and the apply
  path recomputes against the current state — drift or substitution
  between review and apply fails closed. Recovery never runs
  automatically, and the pattern matches the rest of the system: the
  MCP `spec_stage_apply` dual-hash + `apply-reviewed-candidate` binding
  and `run recover-lock`, which demands positive staleness evidence plus
  an explicit `--remove` flag.
- **Residual risk:** recovery rewrites state by design; a human approving
  the wrong plan is not detectable by hashing.
- **User responsibility:** read the plan; keep `.specbridge` in version
  control or backups so recovery is comparison, not archaeology.

---

## 8. Supply chain

### T25 — Release supply chain

- **Asset:** the artifacts users install (npm packages, plugin ZIP, GitHub
  Action bundle, release archives).
- **Trust boundary:** the source repository → published artifacts.
- **Threat:** a published artifact that does not match the reviewed source.
- **Existing mitigation:** CI installs with a frozen lockfile and runs
  fully offline after dependency install — no LLM, no API key, no
  external service. The plugin and GitHub Action bundles are reproducible
  (no timestamps, no absolute paths, no source maps) and **rebuilt and
  diffed against the committed artifacts in CI**, so the shipped bundle
  provably matches the source. The plugin ships a SHA-256
  `checksums.json` recomputed by `pnpm validate:plugin` and verified by
  tests; the validator also rejects workspace imports and absolute build
  paths in shipped artifacts, and the release ZIP excludes source maps,
  tests, `node_modules`, `.git`, `.kiro`, `.specbridge`, and logs. The
  release checklist requires `npm pack --dry-run` inspection and forbids
  overwriting an existing tag or Release.
- **Residual risk:** v1.0.0 publishes checksums, not signatures — no
  signed provenance or attestation is claimed for npm packages or release
  assets.
- **User responsibility:** install from the official repository and npm
  package only; verify checksums where published.

### T26 — Compromised dependencies

- **Asset:** everything, transitively.
- **Trust boundary:** the npm ecosystem → the SpecBridge runtime.
- **Threat:** a malicious or hijacked dependency version entering a build.
- **Existing mitigation:** the pnpm lockfile is committed and CI uses
  `pnpm install --frozen-lockfile`; the runtime dependency footprint is
  deliberately small (the CLI's external runtime dependencies are
  `commander` and `picocolors`; templates and the extension protocol are
  dependency-free by design). The MCP SDK is pinned exactly (`1.29.0`);
  dependency updates for bundled artifacts are explicit diffs, never
  floating ranges, and `THIRD_PARTY_LICENSES.txt` enumerates every
  bundled package.
- **Residual risk:** an upstream compromise inside a pinned version, or a
  poisoned new version accepted in a future update, remains possible;
  SpecBridge claims no automated vulnerability-scanning guarantee.
- **User responsibility:** review lockfile diffs in contributions like any
  other code.

### T27 — GitHub Actions permissions

- **Asset:** the repository and its CI credentials.
- **Trust boundary:** workflow runs (including on pull requests) → repo
  permissions.
- **Threat:** an over-privileged or injected workflow modifying the repo
  or exfiltrating secrets.
- **Existing mitigation:** every workflow declares top-level
  `permissions: contents: read`. CI needs no secrets, no model, and no
  API key. The skill-verification workflow downloads its verifier as a
  pinned release verified against a hardcoded SHA-256. The shipped
  SpecBridge GitHub Action itself needs no secrets and no network, never
  modifies tracked files, and its bundle is diffed in CI (T25).
- **Residual risk:** third-party actions (`actions/checkout@v4`, etc.) are
  pinned by version tag, not by commit SHA.
- **User responsibility:** maintainers review any workflow change as
  security-sensitive.

### T28 — Binary asset integrity

- **Asset:** downloaded release artifacts and extension archives.
- **Trust boundary:** a download → the bytes you execute or install.
- **Threat:** corruption or substitution between publication and install.
- **Existing mitigation:** SHA-256 everywhere a download exists: the
  plugin ships `checksums.json`; registry entries carry the exact archive
  SHA-256 and installs refuse mismatched bytes (SBE009); release archives
  are published with SHA-256 checksum manifests per the release
  checklist; reproducible bundles let anyone rebuild and compare.
- **Residual risk:** a checksum fetched from the same place as the
  artifact only proves the two match each other (see non-claims).
- **User responsibility:** verify checksums after downloading; fetch from
  the official repository.

### T29 — Unsigned binaries

- **Asset:** confidence in who produced an artifact.
- **Trust boundary:** the publisher's identity → the artifact.
- **Threat:** a convincingly named artifact from someone else entirely.
- **Existing mitigation:** none pretended — this is a limitation, stated
  plainly: SpecBridge 1.0 artifacts are **not code-signed** (no
  Authenticode, no notarization, no signing attestation). Integrity is
  checksum-based (T28); identity rests on the distribution channel.
- **Residual risk:** operating systems may warn on unsigned executables;
  no cryptographic identity proof exists.
- **User responsibility:** obtain SpecBridge only from
  `github.com/HelloThisWorld/specbridge` and the official npm package.

---

## Explicit non-claims

Security models fail through overclaiming. SpecBridge does **not** claim:

1. **Extension process isolation is NOT an OS sandbox.** Out-of-process
   execution, sanitized environments, and permission hashes are safety and
   audit boundaries. An enabled executable extension runs as local code
   with your operating-system permissions — nothing confines its
   syscalls.
2. **Checksums do NOT prove publisher identity.** A SHA-256 proves the
   bytes you have are the bytes that were hashed — nothing about who
   hashed them. Artifacts are unsigned (T29).
3. **Registry listing is NOT endorsement.** The community index is
   metadata anyone can propose; listing implies no review, no audit, and
   no security guarantee. Entries that misdeclare permissions or mutate
   published archives are removed — after the fact.
4. **Binaries may be unsigned.** No code-signing, notarization, or
   provenance attestation is part of the 1.0 release process.
5. **Model-assisted workflows are nondeterministic.** Anything a model
   authors — spec prose, code edits, refinements — can differ between
   runs and can be wrong. SpecBridge makes the *controls* deterministic
   (hashes, approvals, evidence, verification rules), never the model
   output they govern.

If you believe any mitigation above does not hold, that is a security
finding: see [SECURITY.md](../../SECURITY.md) for how to report it.
