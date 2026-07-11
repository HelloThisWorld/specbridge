# Requirements Document

## Introduction

Session timeout handling, written in a hurry.

## Requirements

### Requirement 1: Timeout enforcement

**User Story:** As a security officer, I want idle sessions to expire, so that sessions are safe.

#### Acceptance Criteria

1. WHEN a session is idle for 30 minutes.
2. The feature works correctly for all users.
3. Handle expired tokens gracefully.
4. IF a request arrives with an expired token the request is turned away somehow.
