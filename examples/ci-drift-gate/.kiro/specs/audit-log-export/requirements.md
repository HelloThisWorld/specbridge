# Requirements Document

## Introduction

Compliance officers export audit log entries for a date range as CSV.
Exports must redact personal data and leave a trace of who exported what.

## Requirements

### Requirement 1

**User Story:** As a compliance officer, I want to export audit entries for a date range as CSV, so that I can hand auditors a complete, portable record.

#### Acceptance Criteria

1. WHEN an export is requested for a date range THEN the system SHALL produce a CSV containing every audit entry in that range
2. WHEN the range contains no entries THEN the system SHALL produce a CSV with only the header row

### Requirement 2

**User Story:** As a data protection officer, I want personal data redacted in exports, so that audit evidence can be shared without leaking PII.

#### Acceptance Criteria

1. WHEN an entry contains an email address THEN the system SHALL redact the local part before it is written to the CSV
2. WHEN an entry contains an IPv4 address THEN the system SHALL mask the final octet before it is written to the CSV
3. IF a value cannot be redacted safely, THEN THE SYSTEM SHALL abort the export before any row is written

### Requirement 3

**User Story:** As a security engineer, I want every export recorded, so that access to audit data is itself auditable.

#### Acceptance Criteria

1. WHEN an export completes THEN the system SHALL record the requesting user, the date range, and the completion time in the export log

## Out of Scope

- Scheduled or recurring exports.
- Export formats other than CSV.

## Non-Functional Requirements

- Security: redaction failures abort the export; unredacted rows are never written.
- Performance: exporting one month of entries completes within one minute.
