# Design Document

## Overview

Export pipeline that streams report data to object storage.

## Architecture

A queue-backed worker reads export jobs and streams rows to a storage
adapter. Backpressure is handled by the queue, not in memory.

## Components and Interfaces

- ExportScheduler: enqueues jobs (`schedule(jobSpec): JobId`).
- ExportWorker: consumes jobs, streams rows.
- StorageAdapter interface: `putStream(key, stream)`.

## Data Model

- ExportJob: id, reportId, requestedBy, format, state.

## Failure Handling

- Worker crash: the job lease expires and another worker resumes it.
- Storage unavailable: exponential backoff, job fails after 5 attempts.

## Security Considerations

- Signed URLs expire after 15 minutes; exports are private by default.

## Observability

- Metrics: export duration, failure count, queue depth.

## Testing Strategy

- Unit tests for the scheduler and adapters; integration test with a fake
  storage backend; regression test for resumed jobs.

## Risks and Trade-offs

- Streaming keeps memory flat but makes retries coarser (whole-job retry).

## Alternatives Considered

- Direct synchronous export from the API process: rejected, ties up web workers.
