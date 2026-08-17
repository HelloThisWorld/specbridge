# Requirements Document

## Introduction

This document specifies action routing for StepRelay: how a next message
reaches the worker responsible for the following action in a workflow.

It is deliberately UNDERSPECIFIED on the routing mechanism. Two materially
different designs satisfy every criterion below, and choosing between them is
a user decision — not an inference an implementer may make.

## Requirements

### Requirement 1: Route a next message to the correct worker

**User Story:** As a workflow author, I want each action handled by the worker that owns it, so that a run advances correctly.

#### Acceptance Criteria

1. WHEN an action completes, THE SYSTEM SHALL emit a next message identifying the following action.
2. WHEN a next message is emitted, THE SYSTEM SHALL deliver it to a worker that handles the identified action.
3. IF no worker handles the identified action, THEN THE SYSTEM SHALL record the run as blocked and SHALL NOT drop the message.

### Requirement 2: Preserve run identity across hops

**User Story:** As an operator, I want to trace a run end to end, so that I can diagnose failures.

#### Acceptance Criteria

1. WHEN a next message is emitted, THE SYSTEM SHALL carry the run identifier unchanged.
2. WHEN a worker handles a message, THE SYSTEM SHALL record the transition against that run identifier.

## Out of Scope

- Cross-region replication is excluded.
- Workflow versioning is excluded.

## Non-Functional Requirements

- Routing a next message SHALL add no more than 50 ms on the reference environment.
