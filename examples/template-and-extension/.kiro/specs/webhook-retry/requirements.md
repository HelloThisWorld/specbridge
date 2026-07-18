# Requirements Document

## Introduction

Failed webhook deliveries are retried with exponential backoff so that
transient receiver outages do not lose events.

## Requirements

### Requirement 1

**User Story:** As an integrator, I want failed webhook deliveries retried, so that a transient receiver outage does not lose events.

#### Acceptance Criteria

1. WHEN a delivery attempt fails THEN the system SHALL schedule a retry with exponential backoff
2. IF every retry attempt fails, THEN THE SYSTEM SHALL park the event for manual replay

## Out of Scope

- Receiver-side deduplication guidance.
- Delivery ordering guarantees across events.

## Non-Functional Requirements

- Reliability: a parked event is never deleted automatically.
- Observability: each retry attempt is recorded with its failure reason.
