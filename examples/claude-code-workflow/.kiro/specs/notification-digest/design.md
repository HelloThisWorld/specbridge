# Design Document

## Overview

A digest queue sits between notification creation and email delivery. A
scheduler closes the daily window, renders one summary email per user from
the queued entries, and hands it to the existing email sender. Urgent
notifications skip the queue entirely.

## Architecture

- Notification creation consults the user's digest preference.
- Non-urgent notifications append to the per-user digest queue.
- A daily scheduler drains each user's queue into a single rendered email.
- Failed sends stay queued and are retried by the same scheduler.

## Components and Interfaces

- **DigestQueue** — `enqueue(userId, notificationId)`, `drain(userId)`;
  the only writer of `digest_queue` rows.
- **DigestScheduler** — closes the daily window, calls `drain` per user,
  and passes the rendered summary to the existing `EmailSender` interface.
- **PreferenceStore** — `isDigestEnabled(userId)`; consulted at creation
  time so the routing decision is made exactly once per notification.

## Data Models

- `digest_queue(user_id, notification_id, queued_at)`
- `digest_delivery(user_id, window_date, status, attempts, last_error)`

## Error Handling

- A failed digest send records the failure and is retried within fifteen
  minutes; after the final retry an alert metric is emitted.
- Queue writes are transactional with notification creation; a queue
  failure falls back to immediate delivery rather than dropping the event.

## Security Considerations

- Digest rendering reads only notifications owned by the recipient; the
  drain query filters by `user_id` at the database layer.
- Rendered digests contain notification titles only, never message bodies,
  so a misdelivered email leaks no conversation content.

## Risks and Trade-offs

- Batching delays non-urgent delivery by up to one window; accepted, and
  urgent notifications bypass the queue (Requirement 2).
- A single scheduler is a throughput bottleneck at very large user counts;
  accepted for now, the drain is idempotent so it can be sharded later.

## Testing Strategy

- Unit tests for queue append, urgent bypass, and empty-window behavior.
- Integration test proving one email per user per window.
- Failure-injection test for the retry and alert path.
