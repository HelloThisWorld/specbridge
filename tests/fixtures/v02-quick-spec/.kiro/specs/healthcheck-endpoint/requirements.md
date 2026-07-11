# Requirements Document

## Introduction

**Healthcheck Endpoint**

Allow users to select email and push notification preferences.

## Requirements

### Requirement 1: Channel selection

**User Story:** As a registered user, I want to choose which channels deliver notifications, so that I only receive them where I want.

#### Acceptance Criteria

1. WHEN a user saves channel preferences, THE SYSTEM SHALL persist the selection within 2 seconds.
2. IF the preferences service is unavailable, THEN THE SYSTEM SHALL keep the previous preferences and display a retry option.
3. WHEN a notification is sent, THE SYSTEM SHALL deliver it only through channels the user enabled.

### Requirement 2: Default preferences

**User Story:** As a new user, I want sensible notification defaults, so that I receive important messages without setup.

#### Acceptance Criteria

1. WHEN an account is created, THE SYSTEM SHALL enable email notifications and disable push notifications.
2. IF a notification category is mandatory, THEN THE SYSTEM SHALL deliver it regardless of user preferences.

## Non-Functional Requirements

- Performance: preference reads add at most 50 ms to notification dispatch.
- Security: preferences are readable and writable only by the owning user.

## Edge Cases

- A user disables every channel: mandatory notifications still deliver by email.

## Out of Scope

- Digest scheduling and quiet hours.
