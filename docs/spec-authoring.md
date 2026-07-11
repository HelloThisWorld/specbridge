# Spec authoring (`spec new`)

`specbridge spec new <name>` creates a Kiro-compatible spec from offline
Markdown templates. There is no model involved: templates render
deterministically from the name, title, and description you provide, and the
result is plain Markdown that Kiro can open unchanged.

```sh
specbridge spec new notification-preferences
specbridge spec new notification-preferences \
  --type feature \
  --mode requirements-first \
  --title "Notification Preferences"
specbridge spec new cache-fallback \
  --type bugfix \
  --description "Fix stale cache fallback after upstream timeout"
specbridge spec new payment-retry \
  --mode quick \
  --from-file feature-description.md
```

## Spec names

Names become directory names under `.kiro/specs/`, so they are validated
strictly: lowercase letters and digits, single hyphens between words, no
spaces, underscores, path separators, `..`, absolute paths, leading/trailing
or doubled hyphens, and no Windows reserved device names.

Valid: `notification-preferences`, `auth-v2`, `payment-retry`.
Invalid: `NotificationPreferences`, `notification_preferences`,
`../notification`, `-payment`, `payment--retry`.

## Types and modes

| `--type` | `--mode` | First document | Files created |
| --- | --- | --- | --- |
| `feature` (default) | `requirements-first` (default) | requirements.md | full requirements template + pending design/tasks stubs |
| `feature` | `design-first` | design.md | full design template + pending requirements/tasks stubs |
| `feature` | `quick` | all three | meaningful starter content in all three files |
| `bugfix` | any | bugfix.md | bugfix report + fix design + bugfix plan |

Bugfix specs use `bugfix.md` instead of `requirements.md` and render the
same three files in every mode — the mode only changes the approval order
enforced through sidecar state (`design-first` starts with the fix design).

Quick mode generates everything in one step and starts at
`READY_FOR_REVIEW`. Nothing is auto-approved: the approval gates below still
apply, you simply may approve requirements and design in either order.

## Descriptions

The initial description comes from exactly one of:

1. `--description <text>`
2. `--from-file <path>` — a UTF-8 text file **inside the workspace**
   (directories, files over 1 MB, and non-UTF-8 files are rejected;
   non-English content is preserved byte-for-byte)
3. neither — a recognizable placeholder is rendered instead

Passing both `--description` and `--from-file` is an error.

## Placeholders are deliberate

Generated templates contain machine-recognizable placeholders
(`<role>`, `Add edge cases here.`, `TBD`, …). `spec analyze` reports them
and `spec approve` refuses to approve a stage that still contains them —
a template is a starting point, not an approvable document.

## Atomicity

Creation is all-or-nothing. Files are rendered into a temporary directory
under `.specbridge/tmp/` and renamed into `.kiro/specs/<name>` in a single
step; sidecar state is written afterwards. If anything fails — including the
state write — the partially created spec directory is removed and no
temporary files survive. An existing spec is never overwritten (there is no
`--force`), and the error lists the files that are already there.

## Dry runs

`--dry-run` prints the target directory, the files and sidecar state that
would be created, and the full rendered Markdown — without writing anything.
Combined with `--json` the output is machine-readable and, apart from
timestamps, fully deterministic.

## What goes where

- `.kiro/specs/<name>/*.md` — plain Markdown, no front matter, no tool
  metadata, LF line endings. Kiro-compatible by construction.
- `.specbridge/state/specs/<name>.json` — workflow mode, stage statuses,
  approvals. See [sidecar-state.md](sidecar-state.md).
