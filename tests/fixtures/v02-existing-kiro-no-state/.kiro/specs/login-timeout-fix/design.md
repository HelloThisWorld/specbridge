# Fix Design

## Root Cause

The session TTL is read from `config.sessionTimeoutSeconds` but the token
issuer treats the value as minutes, multiplying it once more downstream.

## Proposed Fix

Read the TTL once, in seconds, in the token issuer; delete the second
conversion in the middleware.

## Affected Components

- src/auth/session-service.ts
- src/auth/middleware.ts

## Failure Handling

- If the config value is missing, fall back to 30 minutes and log a warning.

## Alternatives Considered

- Converting in the middleware instead: rejected, the issuer owns the claim.

## Regression Protection

- New regression test pinning a 30-minute expiry claim.

## Validation Strategy

- Run the auth test suite and a manual timeout check in staging.
