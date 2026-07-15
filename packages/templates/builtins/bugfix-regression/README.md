# Bugfix Regression template

A bugfix spec template that keeps the fix honest: evidence before root
cause, root cause before fix, and regression tests before done.

It follows the bugfix format SpecBridge analyzes: current behavior,
expected behavior, unchanged behavior, reproduction, evidence, root cause,
the smallest safe fix, regression tests, and verification.

## Usage

```bash
specbridge template preview bugfix-regression \
  --name checkout-total-rounding \
  --var severity=high

specbridge template apply bugfix-regression \
  --name checkout-total-rounding \
  --var severity=high
```

## Variables

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `affectedArea` | string | `the affected component` | Where the bug appears. |
| `severity` | enum (`low`, `medium`, `high`, `critical`) | `medium` | Impact severity. |

The built-in variables `specName`, `title`, `description`, `kind`, and
`mode` are always available and are set by `--name`, `--title`, and
`--description`.

## What you still fill in

The rendered documents contain `<angle-bracket>` placeholders and
"Add … here." lines by design. `specbridge spec analyze` blocks approval
until they are replaced with real reproduction steps and evidence.
