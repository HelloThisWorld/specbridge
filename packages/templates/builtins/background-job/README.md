# Background Job template

A feature spec template for adding or changing an asynchronous background
job or worker.

It pre-structures the spec around the questions background jobs always
raise: the trigger and scheduling policy, retries and backoff, idempotency
under duplicate delivery, timeouts, dead-letter behavior, cancellation,
observability, and tests. It is vendor-neutral by design — any queue,
scheduler, or worker runtime fits.

## Usage

```bash
specbridge template preview background-job \
  --name invoice-export-worker \
  --var jobName=invoice-export

specbridge template apply background-job \
  --name invoice-export-worker \
  --var jobName=invoice-export
```

## Variables

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `jobName` | string | `background-job` | Short name of the job or worker (lowercase-hyphen). |

The built-in variables `specName`, `title`, `description`, `kind`, and
`mode` are always available and are set by `--name`, `--title`, and
`--description`.

## What you still fill in

The rendered documents contain `<angle-bracket>` placeholders and
"Add … here." lines by design. `specbridge spec analyze` blocks approval
until they are replaced with real content. The template gives structure;
the engineering judgment stays with you.
