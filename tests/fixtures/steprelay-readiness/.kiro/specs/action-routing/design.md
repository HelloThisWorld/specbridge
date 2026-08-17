# Design Document

## Overview

Action routing delivers a next message to a worker that handles the named
action. The transport is abstracted behind a broker interface so the runtime
does not depend on a specific broker product.

## Architecture

The router sits between the action executor and the broker. It reads the
workflow configuration, determines the following action, and hands the next
message to the broker.

> The routing MECHANISM is intentionally left open in this revision. Both a
> topic-per-action topology and a shared queue carrying an action identifier
> satisfy the requirements, with materially different operational trade-offs.
> The mechanism must be decided before implementation.

## Components and Interfaces

- Router: resolves the following action from the workflow configuration.
- Broker interface: publish and subscribe primitives, transport-agnostic.
- Worker registry: which workers handle which actions.

## Error Handling

An unroutable message marks the run blocked and preserves the message; no
message is ever silently dropped.

## Security Considerations

Message payloads carry no credentials. The broker connection is configured
outside the runtime.

## Testing Strategy

Unit tests cover routing resolution; an integration test covers a two-action
workflow end to end.

## Risks and Trade-offs

- Topic-per-action isolates workers but multiplies broker topics.
- A shared queue keeps topology small but requires action filtering in workers.
