# Bugfix Document

## Summary

**Login Timeout Fix**

Login sessions expire after 5 minutes instead of the configured 30 minutes.

## Current Behavior

Users are logged out after roughly 5 minutes of inactivity even though the
session timeout is configured as 30 minutes.

## Expected Behavior

Sessions stay valid for the configured 30 minutes of inactivity and refresh
on activity.

## Unchanged Behavior

- Explicit logout still ends the session immediately.
- Password changes still invalidate all sessions.

## Reproduction

1. Log in with any account.
2. Wait 6 minutes without interacting.
3. Click any authenticated link: the app redirects to the login page.

## Evidence

- Logs: session-service rejects tokens with "exp claim in the past".
- Failing tests: SessionServiceTest.testTimeoutHonorsConfiguration.
- Relevant source locations: src/auth/session-service.ts.

## Constraints

- The fix must not invalidate existing active sessions on deploy.

## Regression Risks

- Token refresh flow: refreshing must not extend beyond the absolute cap.
