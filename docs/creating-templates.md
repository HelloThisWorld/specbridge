# Creating templates

This is the contributor happy path: scaffold a template pack, edit plain
Markdown, validate, try it locally, share it. No TypeScript is ever
required — a template pack is a JSON manifest plus Markdown files, and
that is the whole format. For what templates are and what they cannot do,
start with [the template overview](templates.md).

## 1. Scaffold a pack

```bash
specbridge template scaffold my-template --kind feature --output ./my-template
```

This generates a complete, already-valid pack:

```
my-template/
├── specbridge-template.json      # the manifest
├── README.md                     # usage, variables table, checklist
└── files/
    ├── requirements.md.template
    ├── design.md.template
    └── tasks.md.template
```

A `--kind bugfix` scaffold generates `files/bugfix.md.template` instead of
`files/requirements.md.template` — the file set always mirrors the full
Kiro layout for the kind, nothing more and nothing less:

| Kind | Rendered files |
| --- | --- |
| `feature` | `requirements.md`, `design.md`, `tasks.md` |
| `bugfix` | `bugfix.md`, `design.md`, `tasks.md` |

Useful scaffold options: `--modes` (comma-separated workflow modes),
`--display-name`, `--description`, `--license` (default `MIT`), and
`--dry-run` to list the files without writing. Scaffolding works outside a
SpecBridge workspace too — you do not need a `.kiro` project to author a
template — and it never overwrites an existing directory.

## 2. Edit the template files and manifest

Template files are plain Markdown with `{{variable}}` placeholders. There
are no scripts, expressions, conditionals, or loops — the
[rendering rules](template-rendering.md) are deliberately small. The
scaffold starts you with the built-in variables (`{{title}}`,
`{{description}}`) and one example variable (`actor`); declare your own in
the manifest's `variables` array. Use `<angle-bracket>` placeholders for
content the spec author fills in by hand after applying.

Everything the manifest can say — IDs, variables, constraints, file
entries, compatibility — is specified in the
[manifest reference](template-manifest.md).

## 3. Validate

```bash
specbridge template validate ./my-template

# Treat warnings (missing README, stylistic render findings) as failures:
specbridge template validate ./my-template --strict
```

Validation checks the pack structure, the manifest, every declared file,
and a full render with deterministic sample values, and reports every
issue at once with a stable `SBT` code and a category (`manifest`,
`variables`, `rendering`, `kiro-layout`, …). Add `--json` for a
machine-readable report.

## 4. Install and preview locally

```bash
specbridge template install ./my-template

specbridge template preview project:my-template --name example-spec
```

Install copies the validated pack into `.specbridge/templates/my-template/`
(atomically, never overwriting — see
[installation](template-installation.md)). Preview renders everything and
writes nothing; `template apply --dry-run` does the same through the exact
same rendering path. When the output looks right:

```bash
specbridge template apply project:my-template --name my-first-real-spec
```

The `project:` prefix is only mandatory when the same ID also exists as a
built-in; an unambiguous ID works unqualified.

## 5. Share it

A template pack is just a directory of text files. To share it:

- **Within a team**: commit the directory to your repository (anywhere
  inside it) and let teammates run
  `specbridge template install ./path/to/my-template`. There is no remote
  registry, URL, or npm installation in v0.7.0 — installation reads a
  local directory inside the repository, and nothing else. A community
  index is deferred to v0.7.1+ per the [roadmap](roadmap.md).
- **As a built-in**: open a pull request adding the pack under
  `packages/templates/builtins/` in this repository — see the
  [contribution guide](template-contribution-guide.md).

## Related documentation

- [Template overview](templates.md)
- [Manifest reference](template-manifest.md)
- [Rendering rules](template-rendering.md)
- [Installation](template-installation.md)
- [Security](template-security.md)
- [Contribution guide](template-contribution-guide.md)
