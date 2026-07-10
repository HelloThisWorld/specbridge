# Requirements Document

## Introduction

Customers choose which channels (email, SMS, push) may notify them.

## Requirements

### Requirement 1

**User Story:** As a customer, I want to disable a notification channel, so that I stop receiving messages there.

#### Acceptance Criteria

1. WHEN a customer disables a channel THEN the system SHALL stop sending on that channel within one minute
2. WHEN every channel is disabled THEN the system SHALL still deliver legally required notices by email
