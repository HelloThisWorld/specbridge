# Versioning and stability policy (v1.x)

SpecBridge follows semantic versioning from 1.0.0 onward. The surfaces the
promises below apply to are enumerated — completely — in
[public-contracts.md](public-contracts.md); a surface not listed there is
internal. Machine-readable snapshots of the public contracts live under
`contracts/` and are enforced against every build by
`pnpm check:public-contracts` in CI, so a contract change that is not a
deliberate, reviewed snapshot update fails the build.

## Release types

| Release | May contain | May never contain |
| --- | --- | --- |
| Patch (1.0.x) | bug fixes, doc fixes, performance work, dependency bumps with identical behavior | new public surface, behavior changes to documented contracts |
| Minor (1.x.0) | new commands, options, tools, resources, prompts, rules, templates, runners; new **optional** fields in schemas and payloads; new deprecations | removal or incompatible change of anything documented, silent renames, schema-major bumps |
| Major (2.0.0) | removals and incompatible changes — only for surfaces that were deprecated in a prior v1.x release, with migration tooling where state is involved | undocumented breakage: even a major ships with explicit migration paths |

## Schema versioning

Every persisted file family carries its own `schemaVersion`, independent of
the product version. Shipping a new product release does not bump any
schema; schemas move only when their shape actually changes.

| Family | schemaVersion in 1.0.0 |
| --- | --- |
| spec state | 1.0.0 |
| config | 2.0.0 (v1 = 1.0.0 remains readable, with explicit migration) |
| verification policy, evidence, run/attempt records, registries, registry cache, template manifest/records, extension state/manifest/checksums, verification report/diagnostics, runner contract schemas | 1.0.0 |

- Adding an **optional** field to a family is compatible and needs no
  schema bump; readers pass unknown fields through (machine state) so
  newer files survive older readers within the same major.
- Removing or repurposing a **required** field is a breaking change: new
  schema major, explicit migration tooling, and a product major release.
- Reads never migrate silently. Upgrades are explicit
  (`specbridge migrate`, `specbridge config migrate`) and inspectable
  first (`migrate status`, `migrate plan`, `doctor --repair-plan`).

## Protocol versioning

- **Extension protocol**: 1.0.0. SpecBridge speaks protocol 1.0.0 for all
  of v1.x. A breaking change to the wire protocol is shipped as a new
  protocol version — never as an in-place change to what 1.0.0 means.
- **MCP**: the server targets the pinned official SDK (1.29.0) and the
  2025-11-25 protocol baseline; protocol negotiation is delegated entirely
  to the SDK. Moving the baseline is a deliberate, documented change, not
  a side effect of a dependency bump.

## CLI deprecation policy

A documented CLI command or option is removed only after all three of:

1. a deprecation warning printed on **stderr** whenever it is used
   (stdout, including `--json` output, is never polluted),
2. a documented replacement in the release notes and command help,
3. a stated earliest removal version — never earlier than the next major.

Current deprecations:

| Deprecated | Replacement | Deprecated in | Earliest removal |
| --- | --- | --- | --- |
| `specbridge config migrate` | `specbridge migrate` | 1.0.0 | 2.0.0 |

## Verification rule stability

- A stable rule ID (`SBV###`) keeps its number forever and is never
  renumbered or reused.
- Removing a rule leaves a permanent gap in the sequence.
- New rules append new IDs and may arrive in minor releases; they are
  listed in the release notes so gates can be tuned before upgrading CI.
- Extension-contributed rules live in their own namespace
  (`<extension-id>/<RULE>`) and can never collide with built-in IDs.

## MCP compatibility

- A stable tool name is never silently renamed. A rename is: add the new
  tool, deprecate the old one, remove it no earlier than the next major.
- New tools, resources, prompts, and optional input fields are minor-release
  additions. Existing input schemas only gain optional fields within v1.x.
- Error codes (`SBMCP###`) follow the same rule as verification rules:
  stable, never renumbered.

## Extension SDK compatibility

- An extension built against protocol 1.0.0 and manifest schema 1.0.0
  keeps working across all of v1.x.
- A breaking protocol change requires a new protocol version (and a
  product major to drop support for the old one).
- Additive protocol evolution — new optional request fields, new optional
  capabilities — may arrive in minors; extensions must tolerate unknown
  optional fields, and SpecBridge tolerates extensions that ignore them.
- Manifest `compatibility.specbridge` ranges widen from `<1.0.0` to
  `<2.0.0` at 1.0.0: an extension declaring `<2.0.0` is declaring exactly
  the guarantee this document makes.

## Template compatibility

- A template pack valid under manifest schema 1.0.0 stays valid and
  renders identically across v1.x. The rendering engine's restrictions
  (one pass, `{{variableName}}` only, no expressions, no escapes) are
  permanent design constraints — they will not be "extended" in a way that
  changes what existing templates produce.
- Built-in template IDs are stable; their content may improve in minors,
  which affects newly generated documents only, never existing specs.
- Template manifest engine ranges widen to `<2.0.0` at 1.0.0, same as
  extensions.

## Runner adapter contract versioning

The adapter contract is the set of schema-versioned families adapters are
conformance-tested against: capabilities, normalized events, normalized
results, normalized errors, and usage — all 1.0.0, frozen since v0.6.0.
Within v1.x the contract only grows additively (new optional fields, new
documented enum values). A breaking change to any of these families
requires a new adapter-contract version and a product major. Adapter
conformance suites are versioned with the contract, so a third-party or
extension runner that passed conformance keeps passing across v1.x.

## The ten principles

1. A documented CLI command that works in one v1.x release keeps working
   in every later v1.x release; the only route to incompatible change is
   deprecation now, removal at a major.
2. Sidecar state written by any v1.x release remains readable by every
   later v1.x release.
3. New **optional** fields may be added compatibly — to schemas, reports,
   and protocol payloads — in minor releases.
4. Removing a **required** field is a breaking change and requires a major
   release.
5. A stable verification rule ID is never renumbered; retired IDs leave
   gaps forever.
6. A stable MCP tool name is never silently renamed.
7. A breaking change to the extension protocol means a new protocol
   version, not a redefinition of the current one.
8. A breaking change to the runner adapter contract means a new
   adapter-contract version.
9. Every deprecation ships with a stderr warning, a documented
   replacement, and an earliest removal version no sooner than the next
   major.
10. Experimental functionality sits outside the stable guarantee and is
    clearly marked as experimental wherever it appears.

## What is experimental in 1.0.0

Per principle 10, these surfaces carry no compatibility promise:

- **Antigravity CLI adapter** — declares the `experimental` support level:
  detection and diagnostics only, no TUI/PTY automation, never selected
  automatically.
- **Gemini CLI capability-gated operations** — task execution and task
  resume exist only where detection proves the bounded-edit boundary on
  the installed CLI (auto-edit plus tool allowlist or sandbox); where the
  boundary cannot be proven, the operation is refused as incompatible
  rather than run unsafely. Any runner surface reported at the `preview`
  or `experimental` support level is explicit-selection-only and remains
  outside the stable guarantee.
- **Extension process isolation limits** — a documented limitation rather
  than a surface: out-of-process execution and permission grants are
  safety and audit boundaries, not an OS sandbox, and checksums prove
  integrity, not publisher identity. Rely on them for what they are.

`runner matrix` and `runner doctor` report the effective support level per
profile, so what is experimental on your machine is always inspectable —
never a matter of reading release notes.

## Enforcement

The contract snapshots under `contracts/` capture the CLI tree, exit
codes, report IDs, schema versions, rule IDs, MCP tool/resource/prompt
names, error codes, and adapter contract vocabulary.
`pnpm check:public-contracts` regenerates and compares them in CI on every
build: an accidental contract change fails; a deliberate one is a visible,
reviewable snapshot diff. The promise above is only as good as its
enforcement, and its enforcement is automated.
