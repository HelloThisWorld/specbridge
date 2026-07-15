# Template manifest reference

Every template pack starts with `specbridge-template.json` at its root.
The manifest is inert data: no field is ever executed, fetched, or
interpreted as code. This page documents schema version 1.0.0 field by
field. For the surrounding concepts see [the overview](templates.md); for
how placeholders render see [rendering](template-rendering.md).

## Strictness policy

Unknown fields are **rejected**, not ignored. A manifest is an authored
artifact validated at install and apply time, not machine state that must
round-trip — failing loudly on a typo (`"varaibles"`) beats silently
dropping your variable declarations. If validation reports an unknown key,
fix the spelling; there is no escape hatch.

Readers accept any `1.x` `schemaVersion`. A manifest declaring another
major version fails with SBT005 before any shape checks, so a
future-format pack produces one clear error instead of a wall of
unknown-field complaints.

## Complete example

This is the manifest of the built-in `rest-api` template
(`packages/templates/builtins/rest-api/specbridge-template.json`):

```json
{
  "schemaVersion": "1.0.0",
  "id": "rest-api",
  "version": "1.0.0",
  "displayName": "REST API",
  "description": "A feature spec template for adding or changing a REST API endpoint: request/response contract, validation, status codes, authentication, idempotency, pagination, compatibility, observability, and rollout.",
  "kind": "feature",
  "supportedModes": ["requirements-first", "design-first", "quick"],
  "defaultMode": "requirements-first",
  "tags": ["api", "rest", "http", "backend"],
  "files": [
    {
      "source": "files/requirements.md.template",
      "target": "requirements.md",
      "stage": "requirements",
      "required": true
    },
    {
      "source": "files/design.md.template",
      "target": "design.md",
      "stage": "design",
      "required": true
    },
    {
      "source": "files/tasks.md.template",
      "target": "tasks.md",
      "stage": "tasks",
      "required": true
    }
  ],
  "variables": [
    {
      "name": "actor",
      "description": "Primary caller of the API (a user role or client system).",
      "type": "string",
      "required": false,
      "default": "API client"
    },
    {
      "name": "resourceName",
      "description": "Name of the primary resource the endpoint exposes (singular, e.g. \"order\").",
      "type": "string",
      "required": false,
      "default": "resource"
    },
    {
      "name": "basePath",
      "description": "Base URL path of the endpoint group (e.g. \"/api/v1/orders\").",
      "type": "string",
      "required": false,
      "default": "/api/v1"
    }
  ],
  "compatibility": {
    "specbridge": ">=0.7.0 <1.0.0",
    "kiroLayout": "1"
  },
  "license": "MIT",
  "examples": [
    "specbridge template apply rest-api --name orders-list-endpoint --var resourceName=order --var basePath=/api/v1/orders"
  ]
}
```

## Required fields

### `schemaVersion`

Semver string (`x.y.z`). Must be a `1.x` version; anything else fails
with SBT005.

### `id`

The template's stable identifier, used as its directory name when
installed and in references like `builtin:rest-api`. IDs are strict so
they are always safe as directory names on every platform and can never
smuggle path segments: lowercase ASCII letters and digits, single hyphens
between runs, starting with a letter, at most 64 characters. No
underscores, dots, slashes, spaces, uppercase, or repeated hyphens.
Invalid IDs fail with SBT003.

| Valid | Invalid | Why invalid |
| --- | --- | --- |
| `rest-api` | `REST-API` | uppercase |
| `database-migration` | `my_template` | underscore |
| `cli-tool-v2` | `api--v2` | repeated hyphen |
| `authentication` | `-api`, `api-` | leading/trailing hyphen |
|  | `2fa-setup` | must start with a letter |
|  | `api.v1`, `a/b` | dots and path separators |

### `version`

The template's own version, exact semver (`x.y.z`). Recorded in install
and apply records.

### `displayName` and `description`

Human-readable name (1–100 characters) and description (1–500
characters). Both appear in `template list`, `template show`, and the
generated gallery in [templates.md](templates.md).

### `kind`

`feature` or `bugfix`. Determines the allowed target file set (below) and
the kind of spec that `template apply` creates.

### `supportedModes` and `defaultMode`

`supportedModes` is 1–3 distinct values from `requirements-first`,
`design-first`, `quick`. `defaultMode` must be one of them (SBT004
otherwise); it is used when `--mode` is not passed.

### `tags`

Up to 12 distinct tags, each 1–32 characters matching
`[a-z0-9]+(-[a-z0-9]+)*` (lowercase, digits, single hyphens). Used by
`template list --tag` and `template search`.

### `files`

The rendered files, 1–20 entries. Each entry declares:

- `source` — pack-relative path matching `files/<name>.template` where
  `<name>` is lowercase letters, digits, dots, and hyphens (e.g.
  `files/requirements.md.template`). Forward slashes only; absolute paths
  and `.`/`..` segments are rejected (SBT007/SBT008). Sources live in a
  flat `files/` directory — no nesting.
- `target` — the file name created inside `.kiro/specs/<spec-name>/`.
  Only the exact Kiro layout for the declared `kind` is allowed, and
  every allowed target must appear **exactly once**:
  - `feature`: `requirements.md`, `design.md`, `tasks.md`
  - `bugfix`: `bugfix.md`, `design.md`, `tasks.md`

  Any other target fails with SBT011; a duplicate with SBT012; a missing
  one with SBT004. Variables are never allowed in target paths.
- `stage` — must match the target (`requirements.md` → `requirements`,
  `bugfix.md` → `bugfix`, `design.md` → `design`, `tasks.md` → `tasks`).
- `required` — must be `true`. Kiro layout 1 requires all files for the
  kind; the field exists for forward compatibility, not for optional
  files today.

### `variables`

Up to 30 declared variables. Each has:

- `name` — 1–64 characters matching `[a-z][a-zA-Z0-9]*` (lower
  camelCase), unique, and not one of the built-in names `specName`,
  `title`, `description`, `kind`, `mode`, `generatedDate` — built-ins are
  provided by SpecBridge and cannot be shadowed.
- `description` — 1–500 characters; shown by `template show` and quoted
  in the error when a required variable is missing.
- `type` — `string`, `boolean`, `integer`, or `enum`.
- `required` (default `false`) and `default` — mutually exclusive: a
  variable that is required must not also carry a default. An optional
  variable without a default substitutes as empty text.
- `values` — required for and exclusive to `enum` variables: 1–50
  distinct strings, each 1–200 characters.
- `minLength` / `maxLength` — string variables only, non-negative,
  `minLength <= maxLength`.
- `pattern` — string variables only; a **restricted safe regular
  expression**: at most 200 characters, no backreferences (`\1`–`\9`),
  and no quantified groups like `(…)+` — the shapes behind catastrophic
  backtracking. This is a conservative subset by design; a template that
  needs more should state the expectation in prose instead. Values
  checked against a pattern are additionally capped at 2,000 characters.
- `minimum` / `maximum` — integer variables only, `minimum <= maximum`.

Supplied values are validated and coerced at preview/apply time
(SBT013 missing required, SBT014 unknown or built-in name, SBT015
invalid value). Any string value is capped at 100,000 characters.

### `compatibility`

```json
{ "specbridge": ">=0.7.0 <1.0.0", "kiroLayout": "1" }
```

- `specbridge` — a minimal range grammar: one or more space-separated
  comparators that must all hold, using only `>=`, `<=`, `>`, `<`, `=`,
  or a bare version (meaning `=`). No `^`, `~`, `||`, `x`-ranges, or
  prerelease tags — state an explicit window. An incompatible SpecBridge
  fails with SBT006.
- `kiroLayout` — must be `"1"`, the only supported layout (SBT006
  otherwise).

### `license`

License identifier, 1–50 characters (e.g. `MIT`). Required. Built-in
templates must be MIT.

## Optional safe fields

All optional fields are inert strings or booleans — never executed,
never fetched:

- `author` (1–200 chars), `homepage` (1–500), `repository` (1–500) —
  display metadata only.
- `examples` — up to 5 copy-pasteable command lines (each up to 500
  characters); the first one is shown by `template show` and in the
  generated gallery.
- `deprecated` (boolean) and `replacement` (a valid template ID) —
  applying a deprecated template emits an advisory warning naming the
  replacement; it never blocks.
- `generatedDate` (boolean) — opt-in for the `{{generatedDate}}`
  built-in variable (a `YYYY-MM-DD` date from an injectable clock). Off
  by default so rendering is fully input-determined unless a template
  explicitly asks for the date. See
  [rendering](template-rendering.md).

The manifest itself is limited to 256 KiB (SBT019); pack-wide limits are
listed in [security](template-security.md).

## Related documentation

- [Template overview](templates.md)
- [Creating templates](creating-templates.md)
- [Rendering rules](template-rendering.md)
- [Installation](template-installation.md)
- [Security](template-security.md)
- [Contribution guide](template-contribution-guide.md)
