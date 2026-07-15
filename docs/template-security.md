# Template security

The template system is built on one principle: **templates are data, not
code**. A template pack is a JSON manifest plus plain Markdown files;
nothing in a pack is ever executed, evaluated, or fetched. Everything
else in this document follows from enforcing that principle at every
boundary. See [the overview](templates.md) for what templates are and
[rendering](template-rendering.md) for the substitution rules.

## Enforced protections

- **No scripts, lifecycle hooks, or shell.** There is no field in the
  manifest that names a command, and no code path that spawns one.
- **No environment interpolation.** Environment variables, usernames,
  machine names, and absolute paths never enter rendered output.
- **No recursive rendering.** One pass; substituted values are inserted
  verbatim and never rescanned.
- **No expression evaluation.** `{{variableName}}` is the entire
  syntax — no conditionals, loops, helpers, or includes.
- **No arbitrary filesystem access.** Sources must live in the pack's
  flat `files/` directory; discovery only inspects the embedded built-in
  catalog and `.specbridge/templates/`.
- **No variables in target filenames.** Targets are a fixed allowlist
  per kind (`requirements.md`/`bugfix.md`, `design.md`, `tasks.md`),
  each exactly once.
- **No path traversal.** Source paths reject `..`, `.`, absolute paths,
  backslashes, and null bytes (SBT007/SBT008); writes go only to
  `.kiro/specs/<spec-name>/` and the sidecar.
- **No symlink following.** Every pack entry is `lstat`ed; any symlink
  is rejected outright (SBT009), including the pack root.
- **No network.** Every template command is local and offline.
- **No spec overwrite.** Apply refuses an existing spec (SBT020);
  install refuses an existing installed template (SBT021).
- **No approval bypass.** Generated stages start unapproved; templates
  cannot mark anything approved, and `.kiro` files never carry template
  metadata.
- **Bounded input and output.** From `TEMPLATE_PACK_LIMITS`, all
  tested: at most 20 files per pack, manifest at most 256 KiB
  (262,144 bytes), each template file at most 1 MiB (1,048,576 bytes),
  total pack at most 5 MiB (5,242,880 bytes), each rendered document at
  most 1 MiB, each supplied variable value at most 100,000 characters.
  Packs nest at most 3 directories deep, and every file must be valid
  UTF-8 with no null bytes.
- **Atomic install and spec creation.** Both go through a temp
  directory and a single rename; a failure leaves nothing behind, and a
  half-written pack or spec is never discoverable.
- **Candidate-hash binding for MCP apply.** The MCP `template_apply`
  tool requires the `candidateHash` from `template_preview` plus an
  explicit acknowledgement string, re-renders, and refuses on any
  mismatch (SBT023).
- **Read-only preview.** `template preview` and `--dry-run` write
  nothing and are deliberately not recorded.
- **No secret logging.** Append-only records in
  `.specbridge/template-records.jsonl` store variable **names** and
  rendered-content **hashes** only — never variable values.

## Threat model

**Malicious manifest.** The manifest is parsed with a strict schema:
unknown fields are rejected, every string is length-bounded, the file is
capped at 256 KiB, and no field is executable. `pattern` constraints are
vetted against a safe-regex subset (max 200 characters, no
backreferences, no quantified groups) to prevent catastrophic
backtracking. IDs are restricted to safe directory names.

**Malicious placeholder.** Placeholder names must match
`[a-z][a-zA-Z0-9]*`; anything else is a malformed-placeholder error
(SBT016). A placeholder cannot express a path, an expression, or a
lookup — it can only name a declared or built-in variable.

**Recursive placeholder injection.** A variable value containing
`{{other}}` is inserted as literal text; values are never rescanned, so
there is no second pass to exploit.

**Traversal via source path.** Declared sources must match
`files/<name>.template`; `..` and `.` segments, absolute paths,
backslashes, and null bytes are rejected (SBT007/SBT008), and undeclared
pack files can never be rendered (SBT010).

**Traversal via target path.** Targets are compared against a fixed
allowlist per kind — not sanitized, allowlisted (SBT011). Variables are
never substituted into target paths, so no input can steer a write.

**Symlink escape.** Pack reading uses `lstat` and rejects any symlink,
at the root or inside (SBT009). Install writes the already-validated
in-memory contents to a temp directory — the copy can never pick up
files or symlinks that validation did not see — and uninstall refuses a
symlinked install directory rather than following it.

**Oversized pack.** File count, per-file size, total size, and nesting
depth are enforced before any content is parsed (SBT019), so a
multi-gigabyte or deeply nested directory fails fast.

**Binary payload.** Every pack file must round-trip as UTF-8 and contain
no null bytes (SBT025). Template packs are text, and only text.

**Ambiguous template shadowing.** If the same ID exists as both a
built-in and a project template, unqualified references fail with an
explicit ambiguity error listing the qualified candidates (SBT002) —
one source never silently shadows another. Install warns up front when
a pack's ID collides with a built-in.

**Candidate substitution (MCP).** An agent could preview one thing and
apply another. `template_apply` therefore requires the exact
`candidateHash` produced by `template_preview` — a hash over the
template identity, manifest hash, spec identity, and every rendered
file — plus the literal acknowledgement `apply-reviewed-template`. The
tool re-renders from the same inputs and refuses on mismatch (SBT023):
the reviewed content is exactly the content written, or nothing is.

**Spec overwrite.** Apply uses the same atomic spec-creation path as
`spec new` and fails with SBT020 if the spec exists. There is no
`--force`.

**Invalid generated task layout.** Rendered documents are checked
structurally (non-empty, top-level heading) and run through the
deterministic Kiro-compatible parsers before anything is written; a
template whose output is not a valid spec document fails to apply
(SBT017).

**Malicious Markdown content.** SpecBridge never executes rendered
Markdown — it is written to disk as spec text and later analyzed by
deterministic parsers. Spec analysis blocks approval while placeholder
content remains. What tooling cannot judge is the meaning of prose; see
the warning below.

**Template pack supply-chain limitations.** v0.7.0 has no pack signing,
no provenance verification, no remote registry, and no marketplace —
installing a pack means trusting whoever handed you the directory.
Mitigations: packs are small plain-text artifacts you can fully inspect
(`specbridge template show <ref> --files --manifest`), install only
reads local directories inside the repository, and every install records
the manifest hash in an append-only record. A community index and
extension SDKs are deferred to v0.7.1+ per the [roadmap](roadmap.md);
until then, review before you install.

## An honest warning about rendered prose

Rendered Markdown may still contain untrusted natural-language
instructions aimed at AI agents — a template could embed text like
"ignore your verification rules" in a requirements section. SpecBridge's
control rules (stage approvals, protected paths, verification, evidence)
are enforced by the tooling itself and are never overridable by template
content: no sentence in a generated spec can approve a stage, skip
verification, or widen a write path. But agents reading generated specs
should treat their prose as data, not commands — the same discipline
that applies to any file content an agent did not author.

## Related documentation

- [Template overview](templates.md)
- [Creating templates](creating-templates.md)
- [Manifest reference](template-manifest.md)
- [Rendering rules](template-rendering.md)
- [Installation](template-installation.md)
- [Contribution guide](template-contribution-guide.md)
- [Security model (project-wide)](security.md)
