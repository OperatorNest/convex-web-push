# 0004: One bounded transaction per batch call

## Context

`sendNotificationBatch` used to loop over 25-user chunks of `runMutation`. In a mutation context
every chunk shared one transaction, so the work was unbounded.

## Decision

The client makes exactly one `notifications.sendBatch` call, for at most 100 users. That call
inserts at most 150 deliveries, then schedules `continueBatch` for the remaining users. A larger
audience is sent from an action, one call per slice of 100 users; each call is its own transaction
there. More than 100 users throws `WEB_PUSH_BATCH_TOO_LARGE`.

## Consequences

No client-side chunking and no type-level action requirement. `done` may be false on return;
`getBatch` reports progress.
