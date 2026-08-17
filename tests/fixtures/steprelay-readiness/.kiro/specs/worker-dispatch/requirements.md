# Requirements Document

## Introduction

This document specifies worker dispatch for StepRelay: how a worker receives
the messages for the actions it owns, and how retries and idempotency are
handled.

Unlike the action-routing spec, this one is fully specified: the approved
design commits to one mechanism, so an implementation that uses a different
mechanism contradicts an approved document.

## Requirements

### Requirement 1: Dispatch by action identifier on a shared queue

**User Story:** As an operator, I want a small, stable broker topology, so that adding an action does not change infrastructure.

#### Acceptance Criteria

1. WHEN a next message is published, THE SYSTEM SHALL publish it to the single shared work queue.
2. WHEN a worker receives a message, THE SYSTEM SHALL dispatch it by the action identifier carried in the message.
3. IF the action identifier is unknown to the worker, THEN THE SYSTEM SHALL return the message to the queue without acknowledging it.

### Requirement 2: At-least-once delivery with idempotent handlers

**User Story:** As a workflow author, I want a redelivered message to be safe, so that retries do not corrupt a run.

#### Acceptance Criteria

1. WHEN a handler completes, THE SYSTEM SHALL record the completed transition before acknowledging the message.
2. WHEN a message for an already-completed transition is received, THE SYSTEM SHALL acknowledge it without re-running the handler.
3. IF a handler fails, THEN THE SYSTEM SHALL retry it up to the configured limit before marking the run failed.

## Out of Scope

- Priority queues are excluded.
- Dead-letter routing is excluded from this feature.

## Non-Functional Requirements

- A worker SHALL process a message within 100 ms on the reference environment.
