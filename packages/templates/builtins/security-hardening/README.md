# Security Hardening template

A feature spec template for closing a specific security weakness or
hardening a trust boundary.

It pre-structures the spec around the questions hardening work always
raises: the threat and the assets at risk, the trust boundary and its entry
points, abuse cases, the required secure behavior, an explicit fail-closed
or fail-open decision, logging without secret leakage, dependency
implications, negative tests that prove the attack no longer works, and
rollout. Its claims stay scoped to the weakness being closed — applying the
template does not certify a system as secure.

## Usage

```bash
specbridge template preview security-hardening \
  --name harden-webhook-deserialization \
  --var threatArea=deserialization

specbridge template apply security-hardening \
  --name harden-webhook-deserialization \
  --var threatArea=deserialization
```

## Variables

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `threatArea` | string | `input validation` | The class of weakness being closed. |
| `assetName` | string | `the protected data` | The primary asset at risk behind the boundary. |

The built-in variables `specName`, `title`, `description`, `kind`, and
`mode` are always available and are set by `--name`, `--title`, and
`--description`.

## What you still fill in

The rendered documents contain `<angle-bracket>` placeholders and
"Add … here." lines by design. `specbridge spec analyze` blocks approval
until they are replaced with real content. The template gives structure;
the threat analysis and the engineering judgment stay with you.
