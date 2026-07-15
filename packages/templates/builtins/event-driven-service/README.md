# Event-Driven Service template

A feature spec template for a producer/consumer change on an event bus,
queue, or stream.

It pre-structures the spec around the questions event-driven changes always
raise: the event contract, delivery semantics (an explicit at-least-once or
at-most-once decision — never a claimed exactly-once), ordering, idempotent
consumption, retries and dead-letter behavior, schema evolution, tracing,
contract tests, and rollout.

## Usage

```bash
specbridge template preview event-driven-service \
  --name order-events \
  --var eventName=order-created

specbridge template apply event-driven-service \
  --name order-events \
  --var eventName=order-created
```

## Variables

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `eventName` | string | `resource-updated` | Name of the primary event produced or consumed. |
| `deliverySemantics` | enum | `at-least-once` | Delivery guarantee the design commits to (`at-least-once` or `at-most-once`). |

The built-in variables `specName`, `title`, `description`, `kind`, and
`mode` are always available and are set by `--name`, `--title`, and
`--description`.

## What you still fill in

The rendered documents contain `<angle-bracket>` placeholders and
"Add … here." lines by design. `specbridge spec analyze` blocks approval
until they are replaced with real content. The template gives structure;
the engineering judgment stays with you.
