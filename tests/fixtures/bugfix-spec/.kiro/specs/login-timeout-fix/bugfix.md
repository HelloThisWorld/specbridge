# Login Timeout Fix

## Current Behavior

Signed-in users are logged out after 5 minutes of activity, not 30 minutes
of inactivity. The session sweep compares against `created_at` instead of
`last_seen_at`.

## Expected Behavior

Sessions expire only after 30 minutes without a request. Active users are
never signed out mid-session.

## Unchanged Behavior

- Manual sign-out still invalidates the session immediately
- The lockout rules for failed sign-ins do not change

## Reproduction

1. Sign in
2. Click around continuously for 6 minutes
3. Observe a redirect to the sign-in page on the next navigation

## Evidence

- Support tickets #4312, #4377
- `session_sweep` logs show deletions with recent `last_seen_at` values
