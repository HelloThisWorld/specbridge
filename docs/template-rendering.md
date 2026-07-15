# Template rendering

SpecBridge renders templates with a deliberately restricted engine:
direct scalar substitution, one pass, nothing else. This page is the
complete description of that engine — if a capability is not listed
here, it does not exist. See [the overview](templates.md) for context
and [the manifest reference](template-manifest.md) for how variables are
declared.

## Syntax

The only supported syntax is `{{variableName}}`: two braces, a name
matching `[a-z][a-zA-Z0-9]*`, two braces. No inner whitespace, no dots,
no arguments. Every `{{…}}` occurrence in a template file must resolve
to a declared or built-in variable — a leftover or malformed placeholder
is an error (SBT016), never silently emitted into the output.

Because any double-brace sequence is treated as a placeholder, **literal
double braces are not supported in template files**. A template that
needs to show `{{example}}` as text cannot; there is no escape syntax in
v0.7.0. Validation catches this early: `template validate` reports
malformed and undeclared placeholders per file.

## One pass, values inserted verbatim

Rendering makes a single pass over each template file. Substituted
values are inserted verbatim and **never rescanned**. If a spec author
passes:

```bash
specbridge template apply rest-api --name demo --var resourceName="{{dangerous}}"
```

the rendered document contains the literal text `{{dangerous}}` — it is
not treated as a placeholder, looked up, or expanded. There is no second
pass and no recursion, which closes off placeholder-injection through
variable values entirely.

## What is not supported

- expressions, arithmetic, string operations
- conditionals and loops
- includes, partials, or cross-file references
- helpers, filters, or user-defined functions
- environment-variable access
- file reads or any filesystem access
- a second rendering pass or recursive expansion
- escape sequences for literal `{{` / `}}`

These are permanent design constraints of the data-only template model,
not missing features — see [security](template-security.md).

## Built-in variables

| Variable | Value |
| --- | --- |
| `specName` | the `--name` argument |
| `title` | `--title`, or a title derived from the spec name |
| `description` | `--description`, or the standard placeholder text |
| `kind` | the manifest's `kind` (`feature` or `bugfix`) |
| `mode` | the effective workflow mode |
| `generatedDate` | opt-in only: today's date as `YYYY-MM-DD` (UTC) |

Built-ins are always available (except `generatedDate`), cannot be
shadowed by manifest variables, and cannot be supplied with `--var`
(SBT014) — `title` and `description` have their own options.

`generatedDate` requires `"generatedDate": true` in the manifest. It is
produced from an injectable clock, so tests and validation render
reproducibly; it is the only time-derived value in the whole pipeline,
and it is off by default so rendering stays fully input-determined.

## Errors and limits

- Unresolved or malformed placeholders: SBT016, naming the file and the
  placeholder.
- Rendered output is capped at 1 MB (1,048,576 bytes) per document:
  SBT018.
- Each rendered document must be non-empty and start with a top-level
  `# ` heading (SBT017 otherwise); a missing trailing newline or CRLF
  line endings are warnings. Rendered documents are also run through the
  deterministic Kiro-compatible parsers, whose findings surface as
  warnings.

## Determinism

The same template pack, variable values, spec name, title, description,
and mode always produce byte-identical output. No environment variables,
usernames, machine names, absolute paths, or network data ever enter a
rendered document.

## One rendering path

`template preview`, `template apply --dry-run`, the MCP
`template_preview` tool, and the real `template apply` all execute the
same planning function — there is no second renderer. What preview
showed is exactly what apply writes, and the MCP apply enforces that
with a candidate hash (see
[security](template-security.md#threat-model)).

## Related documentation

- [Template overview](templates.md)
- [Creating templates](creating-templates.md)
- [Manifest reference](template-manifest.md)
- [Installation](template-installation.md)
- [Security](template-security.md)
- [Contribution guide](template-contribution-guide.md)
