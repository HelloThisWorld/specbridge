# Authentication template

A feature spec template for adding or changing authentication or
authorization behavior.

It pre-structures the spec around the questions authentication changes
always raise: the credential and session flow, authorization boundaries,
wrong-credential and lockout behavior, expiry, revocation, replay
protection, rate limiting, audit events, and security tests. It is
vendor-neutral by design — it names mechanisms, not products.

## Usage

```bash
specbridge template preview authentication \
  --name login-session-refresh \
  --var actor=user \
  --var sessionKind=token

specbridge template apply authentication \
  --name login-session-refresh \
  --var actor=user \
  --var sessionKind=token
```

## Variables

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `actor` | string | `user` | Primary actor who authenticates (a user role or client system). |
| `sessionKind` | enum: `token`, `cookie`, `session` | `token` | Kind of credential artifact issued after successful authentication. |

The built-in variables `specName`, `title`, `description`, `kind`, and
`mode` are always available and are set by `--name`, `--title`, and
`--description`.

## What you still fill in

The rendered documents contain `<angle-bracket>` placeholders and
"Add … here." lines by design. `specbridge spec analyze` blocks approval
until they are replaced with real content. The template gives structure;
the engineering judgment stays with you.
