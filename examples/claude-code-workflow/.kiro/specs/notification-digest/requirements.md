# Requirements Document

## Introduction

Users receive one daily digest email summarizing their unread notifications
instead of a separate email per event. Urgent notifications bypass the
digest and are delivered immediately.

## Requirements

### Requirement 1

**User Story:** As a user, I want unread notifications collected into a daily digest, so that I receive one summary email instead of many single emails.

#### Acceptance Criteria

1. WHEN a notification is created and digest mode is enabled THEN the system SHALL queue it for the next digest instead of sending an immediate email
2. WHEN the daily digest window closes THEN the system SHALL send one email containing every queued notification
3. WHEN the queue is empty at the window close THEN the system SHALL send no digest email

### Requirement 2

**User Story:** As a user, I want to opt out of the digest per channel, so that urgent messages still reach me immediately.

#### Acceptance Criteria

1. WHEN digest mode is disabled THEN the system SHALL deliver notifications immediately
2. WHEN a notification is marked urgent THEN the system SHALL deliver it immediately even while digest mode is enabled

### Requirement 3

**User Story:** As an operator, I want digest delivery to be observable, so that missed digests are detected before users report them.

#### Acceptance Criteria

1. WHEN a digest send fails THEN the system SHALL record the failure and retry within fifteen minutes
2. IF a digest send fails permanently THEN THE SYSTEM SHALL emit an alert metric

## Out of Scope

- Weekly or monthly digest frequencies.
- Digest delivery over SMS or push channels.

## Non-Functional Requirements

- Privacy: digest content is only ever sent to the notification owner.
- Reliability: a digest failure never blocks immediate urgent delivery.
