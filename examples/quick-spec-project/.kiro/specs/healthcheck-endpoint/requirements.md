# Requirements Document

## Introduction

A `/healthz` endpoint for load balancers.

## Requirements

### Requirement 1

**User Story:** As an operator, I want a health endpoint, so that the load balancer can rotate unhealthy instances out.

#### Acceptance Criteria

1. WHEN the service is healthy THEN the system SHALL respond 200 within 100 ms
2. WHEN a critical dependency is down THEN the system SHALL respond 503 with the failing dependency named
