# Design Document

## Overview

A per-customer preferences record consulted by the notification dispatcher.

## Data Models

- `notification_preferences(customer_id, channel, enabled, updated_at)`

## Error Handling

- Missing preference rows default to enabled
- Dispatcher failures never block the triggering transaction

## Testing Strategy

- Unit tests for preference resolution
- Integration test proving the one-minute propagation bound
