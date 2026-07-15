# REST API template

A feature spec template for adding or changing a REST API endpoint.

It pre-structures the spec around the questions REST changes always raise:
the request/response contract, validation and status codes, authentication
and authorization, idempotency, pagination, backward compatibility,
observability, contract tests, and rollout.

## Usage

```bash
specbridge template preview rest-api \
  --name orders-list-endpoint \
  --var resourceName=order \
  --var basePath=/api/v1/orders

specbridge template apply rest-api \
  --name orders-list-endpoint \
  --var resourceName=order \
  --var basePath=/api/v1/orders
```

## Variables

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `actor` | string | `API client` | Primary caller of the API. |
| `resourceName` | string | `resource` | Primary resource the endpoint exposes (singular). |
| `basePath` | string | `/api/v1` | Base URL path of the endpoint group. |

The built-in variables `specName`, `title`, `description`, `kind`, and
`mode` are always available and are set by `--name`, `--title`, and
`--description`.

## What you still fill in

The rendered documents contain `<angle-bracket>` placeholders and
"Add … here." lines by design. `specbridge spec analyze` blocks approval
until they are replaced with real content. The template gives structure;
the engineering judgment stays with you.
