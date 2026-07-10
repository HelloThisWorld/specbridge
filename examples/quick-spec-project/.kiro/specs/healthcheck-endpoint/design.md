# Design Document

## Overview

A dependency-probing health endpoint with cached probe results (2 s TTL) so
health checks never stampede the database.

## Components and Interfaces

- `HealthService.check()` — aggregates dependency probes
- `GET /healthz` — thin route over `HealthService`

## Testing Strategy

- Unit tests with stubbed probes for healthy/degraded/down states
