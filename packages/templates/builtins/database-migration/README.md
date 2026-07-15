# Database Migration template

A feature spec template for a schema and/or data migration.

It pre-structures the spec around the questions migrations always raise:
the schema change itself, the batched data backfill, backward compatibility
and zero-downtime deployment order, indexes and locking, rollback
limitations (including steps that cannot be reversed), performance,
validation, and observability.

## Usage

```bash
specbridge template preview database-migration \
  --name orders-status-backfill \
  --var tableName=orders

specbridge template apply database-migration \
  --name orders-status-backfill \
  --var tableName=orders
```

## Variables

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `tableName` | string | `records` | Primary table the migration changes. |

The built-in variables `specName`, `title`, `description`, `kind`, and
`mode` are always available and are set by `--name`, `--title`, and
`--description`.

## What you still fill in

The rendered documents contain `<angle-bracket>` placeholders and
"Add … here." lines by design. `specbridge spec analyze` blocks approval
until they are replaced with real content. In particular, the "Rollback
Limitations" section only stays honest if you identify the genuinely
irreversible steps yourself. The template gives structure; the engineering
judgment stays with you.
