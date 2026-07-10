# Fix Design

## Root Cause

`SessionStore.sweepExpired` computes the cutoff from `created_at`. The
column was renamed during the sessions migration and the sweep query was
never updated.

## Proposed Fix

Compare against `last_seen_at`, and add a database constraint test that
fails if either column is renamed again without updating the sweep.

## Regression Risks

- Sessions that never update `last_seen_at` (health checks) could live forever;
  cap absolute session age at 12 hours

## Validation Strategy

- Clock-controlled integration test covering both expiry paths
- Manual verification in staging with a 2-minute sweep interval
