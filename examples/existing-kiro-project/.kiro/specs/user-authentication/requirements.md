# Requirements Document

## Introduction

This feature adds email/password authentication with session management to
Acme Portal. Customers sign in with existing credentials; sessions expire
after inactivity to protect shared devices.

## Requirements

### Requirement 1

**User Story:** As a registered customer, I want to sign in with my email and password, so that I can access my account.

#### Acceptance Criteria

1. WHEN a customer submits valid credentials THEN the system SHALL create a session and redirect to the dashboard
2. WHEN a customer submits invalid credentials THEN the system SHALL show a generic error without revealing which field was wrong
3. IF a customer fails sign-in five times within ten minutes THEN the system SHALL lock the account for fifteen minutes

### Requirement 2

**User Story:** As a signed-in customer, I want my session to expire after inactivity, so that my account stays safe on shared devices.

#### Acceptance Criteria

1. WHEN a session is inactive for 30 minutes THEN the system SHALL invalidate the session
2. WHEN a session expires THEN the system SHALL redirect the next request to the sign-in page
3. WHEN a customer signs out THEN the system SHALL invalidate the session immediately
