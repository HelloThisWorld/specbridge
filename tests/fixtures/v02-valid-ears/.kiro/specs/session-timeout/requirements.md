# Requirements Document

## Introduction

Session timeout handling for authenticated users.

## Requirements

### Requirement 1: Timeout enforcement

**User Story:** As a security officer, I want idle sessions to expire, so that unattended sessions cannot be hijacked.

#### Acceptance Criteria

1. WHEN a session is idle for 30 minutes, THE SYSTEM SHALL invalidate the session token.
2. IF a request arrives with an expired token, THEN THE SYSTEM SHALL respond with 401 and no session data.
3. WHILE a session refresh is in progress, THE SYSTEM SHALL reject concurrent refresh attempts for the same token.
4. WHERE single sign-on is enabled, THE SYSTEM SHALL propagate the logout to the identity provider.
5. The system SHALL record every forced logout in the audit log.

## Out of Scope

- Remember-me tokens.

## Non-Functional Requirements

- Security: token invalidation propagates within 5 seconds.
