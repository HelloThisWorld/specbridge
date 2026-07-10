# Requirements Document

## Introduction

Per-channel notification preferences (email, SMS, push). Requirements are
drafted; design and tasks have not been written yet.

## Requirements

### Requirement 1

**User Story:** As a customer, I want to choose which channels notify me, so that I only get messages where I want them.

#### Acceptance Criteria

1. WHEN a customer disables a channel THEN the system SHALL stop sending on that channel within one minute
2. WHEN a customer has disabled every channel THEN the system SHALL still deliver legally required notices by email
