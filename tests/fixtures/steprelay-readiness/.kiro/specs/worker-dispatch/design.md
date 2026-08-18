# Design Document

## Overview

Worker dispatch uses ONE shared work queue. Every next message carries an
action identifier, and each worker dispatches on that identifier. This is a
committed decision, not an open option: topic-per-action was considered and
rejected because it couples infrastructure changes to workflow authoring.

## Architecture

    router → shared work queue → worker → action handler

There is exactly one queue. Adding an action changes worker code and workflow
configuration; it never changes broker topology.

## Components and Interfaces

- Shared work queue: a single named queue on the broker.
- Dispatcher: maps an action identifier to a registered handler.
- Transition store: records completed transitions before acknowledgement.

## Error Handling

An unknown action identifier is returned to the queue unacknowledged. A
failing handler is retried up to the configured limit, after which the run is
marked failed.

## Security Considerations

Messages carry no credentials. Queue access is configured outside the runtime.

## Testing Strategy

Unit tests cover dispatch and idempotency; an integration test covers a
redelivered message.

## Risks and Trade-offs

- A single queue means one slow action can delay others; this is accepted in
  exchange for a stable topology.
- Workers filter messages they do not own, costing a small amount of throughput.
