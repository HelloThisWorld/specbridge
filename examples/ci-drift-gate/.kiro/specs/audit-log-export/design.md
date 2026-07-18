# Design Document

## Overview

A small export pipeline: the exporter selects entries for the range, the
redactor rewrites PII fields, and the CSV writer streams rows. The export
log records the completed export. The pipeline is pure data-in, data-out so
the redaction rules are fully unit-testable.

## Architecture

Entries flow one way: select entries for the range, redact PII fields,
render CSV rows, then append the export-log record. Each step is a plain
function; only the entry selection and the export log touch storage.

## Components and Interfaces

- **Redactor** (`src/audit/redact.mjs`) — `redactEmail(value)` and
  `maskIp(value)`; pure functions, the only place redaction rules live.
- **Exporter** (`src/audit/exporter.mjs`) — `toCsv(entries)` applies the
  redactor to every entry and renders the CSV, header row included.
- **ExportLog** — appends one record per completed export
  (`export_log(user_id, range_start, range_end, completed_at)`).

## Data Models

- `audit_entry(id, occurred_at, actor_email, source_ip, action)`
- `export_log(user_id, range_start, range_end, completed_at)`

## Error Handling

- A redaction failure aborts the whole export before any row is written
  (fail closed); partial CSVs are never produced.
- An export-log write failure fails the export after the fact and is
  surfaced to the requesting user.

## Security Considerations

- Redaction is applied inside `toCsv`, not by callers, so no code path can
  render an unredacted row.
- The export log itself stores no entry content — only who exported which
  range, and when.

## Risks and Trade-offs

- Masking only the final IPv4 octet keeps entries correlatable but is not
  full anonymization; accepted, documented for auditors.
- Streaming exports were rejected for v1: a one-month range fits memory and
  a pure function is easier to verify (`tests/audit/run-tests.mjs`).

## Testing Strategy

- Deterministic unit tests for `redactEmail`, `maskIp`, and `toCsv`
  (including the empty-range header-only case) in
  `tests/audit/run-tests.mjs` — wired into verification as the trusted
  `audit-tests` command.
