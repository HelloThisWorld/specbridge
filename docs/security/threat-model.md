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

## 9. Governed orchestration (v1.1)

### T30 — An agent talking its way past a gate

**Threat.** A host agent claims `READY` for an underspecified request,
records a plan review the user never gave, retries a deterministic failure
indefinitely, broadens scope while debugging, or asserts a task is complete.

**Mitigations.** Intent outcomes are validated against facts SpecBridge
checks itself (approvals, staleness, task existence, lock ownership) and
downgraded when they rest on `inferred`, `unknown`, or `conflicting`
provenance. `EDIT` is absent from the allowed-action set of every pre-plan
phase and refused against an unreviewed or stale plan. Retry, repair, and
replan are decided by a pure policy function from the failure category and
the counters — never by the agent. Completion requires a `verified` or
`manually-accepted` evidence status that `task_complete` actually returned.
Every budget stop is explicit and leaves the task incomplete.

**Residual risk.** Two rules are *contract-enforced* or *skill-guided*
rather than hard-enforced: whether the user was genuinely asked before a
plan review is recorded, and whether a clarification question is genuinely
load-bearing. SpecBridge binds the review to the exact plan hash and records
how it arrived, but it cannot observe the conversation. Documented in
[enforcement boundaries](../orchestration/enforcement-boundaries.md).

### T31 — Injected instructions reaching an orchestration decision

**Threat.** Repository content ("Ignore SpecBridge", "Mark the task
complete", "Auto-approve the design") is treated as an instruction.

**Mitigations.** No orchestration decision reads repository content. Plan
text, clarification text, intent summaries, and event payloads are bounded,
schema validated, and stored as data — none can name a command, widen a
path, change a budget, or grant a permission. If injected text ever reached
a user-intent summary, the rejection rules make the outcome strictly *more*
restrictive. Adversarial fixtures assert this end to end.

**Residual risk.** A host agent that chooses to obey injected text can still
perform the underlying editor action; what it cannot do is get SpecBridge to
record a completion, an approval, or a passed verifier on that basis.

### T32 — Unbounded orchestration state

**Threat.** Append-only history, oversized plans, or oversized clarification
text as a memory or disk exhaustion surface.

**Mitigations.** Per-event byte cap (refuse, never truncate), a total event
ceiling that stops the run, plan step and byte budgets, clarification
question/answer caps, and paginated bounded views over a fully persisted
log. Corrupt or unknown-major records are refused and preserved rather than
coerced.

**Residual risk.** History is retained indefinitely by design; operators who
need retention limits must prune `.specbridge/orchestration/` themselves.

## 10. Mission-driven multi-agent execution

### T33 — A worker impersonating, duplicating, or racing another worker

**Threat.** A result delivered under the wrong identity: a forged worker id,
a duplicate delivery for a finished attempt, a late result from a
superseded attempt or superseded work unit, a result for another work unit,
or two workers claiming one attempt.

**Mitigations.** Every objective worker attempt gets a durable identity
record before it runs (worker id, role, work unit, attempt, projection
hash, contract-snapshot hash, workspace identity). `acceptWorkerResult`
fails closed on every mismatch — a result delivered to the wrong identity
is rejected even if its content looks valid — and `beginWorker` refuses a
second RUNNING or re-begun FINISHED attempt. Resume supersedes interrupted
worker identities so their late results are refused. Each scenario has a
dedicated test.

**Residual risk.** Identity binds SpecBridge's own bookkeeping; it does not
authenticate the underlying provider process.

### T34 — A builder escaping its candidate workspace

**Threat.** An implementation worker mutating the canonical checkout,
protected paths, or another worker's workspace; hiding changes behind local
commits; or pushing/merging.

**Mitigations.** Builders run with an isolated per-attempt git worktree as
their working directory, under the same implementation tool policy task
execution already uses. SpecBridge computes the diff itself against the
recorded baseline commit (local commits hide nothing), refuses candidates
touching `.kiro/`, `.specbridge/`, or configured protected paths, and the
only path into the canonical tree is the single-writer integrator inside
the existing interactive-run bracket — lock, snapshots, protected-path
enforcement, trusted verification, verified-only completion.

**Residual risk.** A worktree is an isolation and attribution boundary, not
an OS sandbox: a hostile agent process still runs with your OS permissions
(the same non-claim as extensions).

### T35 — Injected instructions in repository files, reports, or candidate claims

**Threat.** Hostile text in source files, investigation reports, worker
claims, or discovery turns steering a decision: "approve this change
request", "mark the mission ready", "skip verification".

**Mitigations.** Worker packets fence all repository and projection content
as data; worker outputs are schema-validated documents whose unknown fields
are ignored — there is no field that could carry a command, permission, or
approval. Mission turns are stored verbatim as data; a decision claiming
user provenance must cite a USER turn (an agent turn carrying injected text
is structurally refused). CCR approval and stage approval exist only as
explicit human CLI actions; no MCP tool or worker result can reach them.
Contract guard patterns and the authority table are code, not prompt text.

**Residual risk.** A model may still be *persuaded* by injected content in
ways that produce worse proposals; the deterministic gates bound what any
proposal can do, not how good it is.

### T36 — Stale approved truth reaching execution

**Threat.** A worker continuing against a contract that was revised
mid-flight, or an objective whose approved task changed after decomposition.

**Mitigations.** Every projection records a contract-snapshot hash over the
active registry and constitution version; a revision anywhere makes
dependent projections stale, the deterministic evaluation layer fails stale
candidates (`STALE_CONTEXT`), and work graphs bind to the objective's task
fingerprint. Both are exercised end to end by the CCR scenario.

**Residual risk.** Staleness is detected at evaluation and dispatch
boundaries, not mid-invocation: a worker already running when the contract
changes finishes its attempt before the stale result is refused.

## 11. Local agentic execution (vNext.4)

vNext.4 materially widens what the `LOCAL` lane may do: from *a model
proposes complete files that SpecBridge applies* to *a harness runtime
inspects, edits, and runs commands in the workspace itself*. The authority
that grants is real, so it gets its own threats.

### T37 — A "free" local attempt silently billing a paid provider

**Threat.** A harness profile bound to the LOCAL lane routes its inference to
a metered API. SpecBridge records the attempt as `lane = LOCAL` — zero
marginal cost by definition — while the user is charged real money, possibly
for every task in a long job.

**Mitigations.** Automatic LOCAL harness execution requires an explicit
binding *and* verified compute locality. Locality is never inferred from a
runner name, a harness name, a provider string, a profile name, or a model
name (`qwen` behind a public endpoint is remote paid compute). It is verified
structurally: an attested loopback `providerEndpoint` that SpecBridge parses
itself (127.0.0.0/8, `::1`, `localhost`, local socket, `file:`/`unix:`), or
the SpecBridge-managed llama.cpp server whose 127.0.0.1 bind no configuration
can widen. `REMOTE` is refused outright; `UNKNOWN` fails closed and is
admitted only by an explicit experimental override that is recorded on the
decision. A wildcard bind address (`0.0.0.0`, `::`) is treated as no evidence,
and hostnames are never DNS-resolved — resolution is not a safety boundary.
The refusal is tested with a remote profile: no runtime process starts and no
inference request is sent.

**Residual risk.** The attestation is a statement about a runtime profile
SpecBridge cannot read (the public DSH SDK exposes no endpoint
introspection). An operator who attests a loopback endpoint while the runtime
actually routes elsewhere defeats the check — SpecBridge verifies the claim's
*shape*, not the runtime's actual socket.

**User responsibility:** attest `computeLocality` from the runtime profile you
actually launched, and leave `allowUnverifiedLocality` off.

---

### T38 — Paid credentials reaching a local-bound runtime

**Threat.** A LOCAL-bound harness inherits `OPENAI_API_KEY` (or similar) and
becomes one configuration edit away from spending money on a lane whose
premise is that it cannot.

**Mitigations.** The runtime child environment is REPLACED with a minimal
safe base plus the profile's explicit `environmentPassthrough` names
(vNext.3), and vNext.4 additionally refuses a LOCAL binding whose passthrough
list contains credential-shaped variable NAMES. Detection is on names only —
values are never read, compared, or logged — and the same finding is reported
by `runner doctor` as a warning.

**Residual risk.** Name-pattern detection cannot recognize a credential
forwarded under an unrecognizable name.

---

### T39 — A local harness mutating control-plane state

**Threat.** The harness now has filesystem and shell tools inside the
workspace. It could write task checkboxes, approvals, sidecar state, or Git
history to fake progress.

**Mitigations.** Prevention plus detection, in that order: the runtime
profile's workspace write boundary must be attested before any execution
(fail closed, vNext.3), the bootstrap prompt states the protected paths and
the completion boundary explicitly, and the evidence pipeline then verifies
independently — protected paths are compared byte-exactly (`.kiro/**`,
`.specbridge/config.json`, `.specbridge/state/**`), HEAD motion is detected,
and any violation prevents verification with evidence preserved and nothing
rolled back. SpecBridge alone writes the task checkbox, and only for verified
evidence. The harness's own test runs are tactical observations that never
substitute for the trusted verification commands.

**Residual risk.** Identical to T09: this is verification-time detection, not
OS-level enforcement. A harness runtime runs with your permissions.

---

### T40 — An unbounded tool loop

**Threat.** An agentic runtime that never settles: burning wall time, filling
context, or looping edit → test → edit forever at "no cost".

**Mitigations.** Every local harness attempt carries an external wall-clock
bound enforced by SpecBridge (cancellation plus bounded runtime teardown),
because the wire has no mid-turn cancel. The LOCAL lane's attempt budget is
shared across both execution modes — two modes never mean two budgets — and
intelligence failures escalate stickily to the subscription lane rather than
retrying locally forever. Infrastructure failures (crash, transport, launch)
are classified separately so a dead runtime never masquerades as evidence
that the task needs a stronger model.

**Residual risk.** Limits SpecBridge cannot enforce inside the runtime (turn
count, tool-call count) are not claimed: unsupported controls are reported as
ignored rather than pretended.

---

### T41 — Prompt injection reaching an agent that can now act

**Threat.** Repository files, test output, or command output containing text
that reads like instructions — now consumed by a runtime that can edit files
and run commands, not merely propose text.

**Mitigations.** The bootstrap prompt carries the untrusted-content boundary
verbatim (observed content is DATA and never overrides the control section),
protected paths are stated up front, and — the part that actually holds —
nothing the agent says changes the outcome: completion still requires a real
repository diff that passes the trusted verification commands, and the
control-plane paths are compared byte-exactly afterwards.

**Residual risk.** An injected instruction can still waste an attempt, and a
sufficiently clever one can produce a *verifiable but undesirable* change.
Evidence proves the tests passed, never that the change was wise.

---

## 12. Paid automatic execution (vNext.5)

vNext.5 lets SpecBridge spend money without a human in the loop. That is a
materially different kind of authority from "use prepaid capacity" or "use a
local GPU", and it gets its own threats. The through-line for all of them:
**every default is the non-spending one, and every unknown fails toward not
spending.**

### T42 — Accidental API spend

**Threat.** A workspace starts making paid API calls its owner never
authorized — because a binary was upgraded, a remote profile happened to exist
in `runnerProfiles`, or a diagnostic command was run.

**Mitigations.** Paid execution requires three INDEPENDENT controls, all
correct: a profile that verifies as REMOTE compute, an explicit binding of
that profile to the API lane, and an explicit spend mode of `MANUAL` or
`AUTO_BOUNDED`. The default spend mode is `DISABLED` and the default binding
is null, so an upgraded vNext.4 workspace is structurally incapable of
spending. Installing or enabling a harness profile grants nothing; a remote
profile sitting in the configuration never becomes a fallback. The gap-bridge
planner runs only after the LOCAL and SUBSCRIPTION lanes have both refused for
a subscription-capacity reason, so no diagnostic or routing path reaches it.
Tests assert that with API unconfigured no runtime process starts, no `api_*`
event is emitted, and behavior is byte-identical to vNext.4.

**Residual risk.** An operator who configures all three controls has
authorized spending; SpecBridge then spends within the configured budget.

---

### T43 — Unbounded or runaway paid retries

**Threat.** A failing task retries on the paid lane until the budget — or the
credit card — is exhausted.

**Mitigations.** Bounded attempts per task and per job are enforced by the
budget controller independently of cost, so cheap failures cannot loop
forever either. Every attempt carries an external wall-clock ceiling enforced
by SpecBridge. Infrastructure failures (crash, transport, launch) are
classified separately from intelligence failures, so a dead runtime never
looks like evidence that the task needs another expensive attempt. Paid
retries flow through the same recovery and escalation governance as every
other lane; there is no paid retry loop of its own.

**Residual risk.** Within the configured attempt and budget ceilings, repeated
failures still cost money. Setting `maxCostPerJobUsd` is the control.

---

### T44 — Unknown cost treated as zero

**Threat.** Pricing is unconfigured, or a workload's token usage is not
estimable, and the scheduler treats "no number" as "free" — spending against a
budget it cannot compute.

**Mitigations.** `ApiCostEstimate.estimatedCostUsd` is `null`, never `0`, when
cost is not derivable, and budget admission refuses a null outright with the
named reason `COST_UNKNOWN`. SpecBridge ships no price table and fetches no
prices at runtime; the operator supplies them with a `source` string recorded
on every estimate. Post-run, an attempt whose real usage cannot be determined
is recorded with cost source `UNKNOWN`, and its budget hold is retained rather
than released.

**Residual risk.** An operator-supplied price table can be wrong or stale.
SpecBridge records where the numbers came from; it cannot verify them.

---

### T45 — Cost-estimate error

**Threat.** The estimate is materially lower than the real cost, so a spend
that should have been refused is admitted.

**Mitigations.** Admission compares a SAFE figure — the mean estimate times a
configurable multiplier (default 1.5) — not the mean. Token heuristics are
deliberately generous rather than optimistic, because an underestimate is the
failure mode that costs money. History replaces heuristics only above a
configured observation floor and always takes the LARGER of history and
heuristic. Per-attempt, per-task, and per-job ceilings all apply
independently.

**Residual risk.** SpecBridge cannot enforce a mid-run cost stop, because the
harness/provider stack exposes no incremental usage. This is stated rather
than papered over: the enforcement is preflight estimation, reservation,
bounded wall time, bounded attempts, and post-run reconciliation.

---

### T46 — Budget race / double reservation

**Threat.** Two eligible tasks each read the same remaining budget and both
spend it, overcommitting.

**Mitigations.** Budget is RESERVED before dispatch through a read-modify-write
behind an exclusive `wx` lock file, and admission is re-evaluated inside the
lock against freshly read durable state — not against whatever the planner saw
a moment earlier. Reservation happens before any attempt record exists, so a
refusal has nothing to unwind. A corrupt budget file is refused loudly rather
than read as an empty budget, which would be the most expensive possible
misread.

**Residual risk.** A stale lock left by a killed process must be removed
manually; the error message says so and names the path.

---

### T47 — Crash with uncertain remote usage

**Threat.** A paid attempt's process dies. SpecBridge cannot know whether the
provider was already billed, and releasing the hold would let a job exceed its
budget simply by crashing.

**Mitigations.** Reservations left `RESERVED` by a vanished process are
reconciled at resume to `UNKNOWN` and **stay charged** against the budget. A
reservation already bound to a started attempt cannot be released at all —
release is reserved for attempts refused before dispatch. Budget summaries
report `hasUnknownCost`, so a committed total is honestly labeled a floor
rather than an exact figure.

**Residual risk.** Conservative accounting can over-charge a budget for an
attempt that in fact never reached the provider. That direction is chosen
deliberately.

---

### T48 — Stale or over-broad spend approval

**Threat.** A human approves paid execution for one task, and that approval
later authorizes materially different work, a different profile, a larger
amount, or an unbounded stream of future spending.

**Mitigations.** SpecBridge never asks "Allow API?". Every approval is scoped
to one task FINGERPRINT (task identity, title, approved-task fingerprint, plan
revision, and dependency set), one profile, one maximum cost, and an expiry —
and all four are re-checked at the moment of spend, with each failure mode
named separately (`FINGERPRINT_CHANGED`, `PROFILE_CHANGED`, `EXPIRED`,
`COST_EXCEEDS_AUTHORIZATION`). Approvals are single-use. A human may authorize
LESS than was requested; the CLI refuses to raise the ceiling above what the
request explained. An explicit denial stands even under `AUTO_BOUNDED`.

**Residual risk.** An approval remains valid for the work it describes until
it expires or is consumed.

---

### T49 — An agent altering its own spending authority

**Threat.** A model or harness — which now has filesystem and shell tools
inside the workspace — edits the budget, the spend mode, the price table, or
an approval amount to authorize its own spending.

**Mitigations.** Spend policy lives in `.specbridge/config.json`, which is a
PROTECTED path: it is compared byte-exactly after every attempt, and any
modification prevents verification with evidence preserved. Budget state and
approval records live under `.specbridge/state/` and the job namespace, also
protected. Approvals are decided only through the CLI by a human — there is no
MCP tool, no agent-reachable API, and no model output that can create one; an
agent can cause a REQUEST to exist by doing work that stalls, and can never
cause an AUTHORIZATION to exist. The bootstrap prompt states the protected
paths explicitly, and — the part that actually holds — nothing the agent says
changes any of it.

**Residual risk.** Identical to T09: this is verification-time detection, not
OS-level enforcement.

---

### T50 — A remote provider misclassified as LOCAL (or the reverse)

**Threat.** A metered profile runs on the zero-cost lane and bills silently,
or a verified-local profile is driven as a paid lane and its "spend" is
fiction.

**Mitigations.** The two bindings are mutually exclusive and mutually honest.
A verified-LOCAL profile is refused for the API lane (`LOCAL_COMPUTE`); a
verified-REMOTE profile is refused for the LOCAL lane (`REMOTE_COMPUTE`, T37);
an `UNKNOWN` profile qualifies for neither by default. One profile may not be
bound to both lanes at once (`BOUND_TO_LOCAL_LANE`). The API binding
deliberately does not consult the managed-local-model attestation, so a
local-attesting profile cannot accidentally verify as remote. Locality is
never inferred from a runner name, a profile name, a provider string, or a
model name. An execution recorded `lane = LOCAL` retains vNext.4's
zero-marginal-cost guarantees, and nothing reclassifies a lane after
execution.

**Residual risk.** As with T37, the attestation describes a runtime profile
SpecBridge cannot read. An operator who misattests defeats the check.

---

### T51 — Credential leakage on the paid lane

**Threat.** A metered provider legitimately needs credentials, and those
values leak into state, logs, evidence, or a decision record.

**Mitigations.** The runtime child environment is REPLACED with a minimal safe
base plus the profile's explicit `environmentPassthrough` NAMES (vNext.3).
SpecBridge records only credential SOURCE names — never values, which are
never read, compared, logged, or persisted. Configuration schemas reject
credential-shaped keys outright. On the API lane these names are expected
rather than disqualifying; on the LOCAL lane they remain disqualifying (T38).

**Residual risk.** The provider process itself holds the credential, as it
must to authenticate.

---

### T52 — Prompt injection inducing broader paid work

**Threat.** Repository content, test output, or a task description contains
text designed to make the agent expand scope — now on a lane that costs money
per token.

**Mitigations.** The economic decision is made entirely OUTSIDE the model. The
lane, the spend mode, the gap assessment, the delay sensitivity, the cost
estimate, and the budget reservation are all deterministic functions of
configuration and durable state; no model output participates in any of them,
and no enum in the scheduling vocabulary can be set from model output. Within
an attempt, the bootstrap prompt carries the untrusted-content boundary
verbatim, the attempt is wall-clock bounded, and the attempt count is bounded.
An injected instruction can waste one bounded, budgeted attempt; it cannot
authorize another one, raise a ceiling, or change a lane.

**Residual risk.** One bounded paid attempt can still be wasted, at a cost no
greater than its reservation.

---

### T53 — Paid execution becoming the default lane

**Threat.** The scheduler drifts into treating the API as an equal strong
lane — routing to whichever provider looks better, or staying on a paid
provider because it succeeded once. This is an architectural risk rather than
an attack, and it is the failure this phase most needs to prevent.

**Mitigations.** `decideLane` is unchanged by vNext.5 and has no way to name
the API lane, so the paid path is unreachable except through the gap-bridge
planner, which runs only over a routing already refused for a
subscription-capacity reason. There is no comparison between providers
anywhere. Prepaid capacity returning mid-attempt does not kill the attempt,
and the next strong task routes back to the subscription lane through the
ordinary scheduler — recorded as an event. Ready-node selection prefers free
and prepaid runnable work over an API-bridged task in the same pass. Mechanical,
local-capable work stays local even during a total subscription outage.

**Residual risk.** None identified for this phase; a future adaptive scheduler
would need its own review.

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
5. **Orchestration governs an agent; it does not make one trustworthy.**
   The v1.1 harness bounds, records, and gates what an agent does, and
   decides completion from evidence rather than assertion. It does not
   verify that an agent's *reported* actions match its real ones — that is
   what the Git snapshot and the trusted verifiers are for — and it does not
   claim that a plan a model wrote is a good plan.
6. **Verified compute locality is an attestation check, not a network
   monitor.** SpecBridge verifies that a locality claim is structurally
   sound (a loopback endpoint it parses, or its own managed server). It does
   not observe the runtime's sockets and cannot detect a runtime that
   contradicts its own profile.
7. **API cost control is preflight and post-run, NOT mid-run.** SpecBridge
   estimates before dispatching, reserves budget, bounds wall time and attempt
   counts, and reconciles afterwards. It does **not** stop a running attempt
   at a cost threshold, because the harness and provider stack expose no
   incremental usage to stop on. Recorded cost is an operator price table
   applied to reported usage — a computation, not an invoice — and an attempt
   that cannot report its usage is recorded as `UNKNOWN`, never as free.
8. **Model-assisted workflows are nondeterministic.** Anything a model
   authors — spec prose, code edits, refinements — can differ between
   runs and can be wrong. SpecBridge makes the *controls* deterministic
   (hashes, approvals, evidence, verification rules), never the model
   output they govern.

If you believe any mitigation above does not hold, that is a security
finding: see [SECURITY.md](../../SECURITY.md) for how to report it.
