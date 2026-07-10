# Design Document

## Context

Customers need CSV/JSON exports of their invoices. Export volume is spiky
(end of quarter), so the pipeline must be queue-based.

## Architecture

Request → export queue → worker → object storage → signed download link.

## Components and Interfaces

- `ExportRequestService` — validates and enqueues requests
- `ExportWorker` — renders CSV/JSON, uploads, records completion

## Failure Handling

- Workers retry three times with backoff; poisoned jobs land in a dead-letter queue

## Testing Strategy

- Contract tests for both output formats
- A load test at 10× normal quarter-end volume
