# Template installation

Templates come from exactly two sources in v0.7.0. There is no remote
registry, no URL installation, and no npm installation — install reads a
local directory inside your repository, and nothing else. A community
index is deferred to v0.7.1+ per the [roadmap](roadmap.md). For the
overall model see [the overview](templates.md).

## Sources

| Source | Reference | Location | Mutability |
| --- | --- | --- | --- |
| Built-in | `builtin:<id>` | embedded in the SpecBridge binary at build time | immutable at runtime, versioned with SpecBridge |
| Project | `project:<id>` | `.specbridge/templates/<id>/` | installed and uninstalled explicitly |

## References and ambiguity

An unqualified reference (`rest-api`) resolves only while exactly one
source provides that ID. If the same ID exists in both sources, every
command fails with an explicit ambiguity error (SBT002) listing the
qualified references — one source never silently shadows another.
`template install` warns up front when a pack's ID collides with a
built-in, because the unqualified reference becomes ambiguous the moment
the install completes.

## Installing

```bash
specbridge template install ./my-template
specbridge template install ./my-template --dry-run   # validate + plan only
```

The source must be a local directory **inside the repository** (SBT007
otherwise — copy the pack in first; installation only reads local,
inspectable paths). The flow:

1. The pack is read with every filesystem check applied (no symlinks, no
   binary files, size and count limits) and fully validated — an invalid
   pack never installs.
2. The validated in-memory contents are written to a temp directory
   under `.specbridge/tmp/`, so the copy can never pick up files that
   validation did not see.
3. The copied pack is re-validated as an independent artifact.
4. One atomic rename moves it to `.specbridge/templates/<id>/`, and an
   append-only install record is written.

There is no `--force` and installs never overwrite: if
`project:<id>` already exists, install fails with SBT021 and tells you
to uninstall first. A failed install leaves nothing behind.

## Uninstalling

```bash
specbridge template uninstall project:my-template
```

Uninstall requires a **qualified `project:` reference** — a bare ID is
refused so the command cannot accidentally target another source, and
built-ins are immutable (SBT022). The directory is atomically renamed
out of `.specbridge/templates/` before deletion, so the catalog never
sees a half-deleted pack. Specs generated from the template and past
template records are untouched — uninstalling a template never deletes
your work.

## What `.specbridge` stores

- `.specbridge/templates/<id>/` — one directory per installed pack,
  byte-identical to what was validated.
- `.specbridge/template-records.jsonl` — append-only, one JSON line per
  apply/install/uninstall/scaffold operation. Records hold safe
  summaries only: template reference and version, manifest hash,
  rendered-file hashes, and variable **names** — never variable values.
  Previews are deliberately not recorded, because preview writes
  nothing.

See [sidecar state](sidecar-state.md) for the wider `.specbridge/`
layout and commit guidance.

## Non-goals in v0.7.0

No remote registry, no `install <url>`, no npm or GitHub installation,
no signed packs, no marketplace. These are honest gaps, not hidden
flags — see [security](template-security.md) for the supply-chain
implications and the [roadmap](roadmap.md) for what v0.7.1+ defers.

## Related documentation

- [Template overview](templates.md)
- [Creating templates](creating-templates.md)
- [Manifest reference](template-manifest.md)
- [Rendering rules](template-rendering.md)
- [Security](template-security.md)
- [Contribution guide](template-contribution-guide.md)
