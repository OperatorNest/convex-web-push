---
"@operatornest/convex-web-push": minor
---

Require Node 24+ and convex-helpers ^0.1.127. Validate and bound subscription, send and history inputs; protect refreshed subscriptions from stale completions and later registrations from ongoing deletion.

Breaking changes:

- Recreate component data when adopting this schema. Indexes now list every field with `_and_`; subscriptions require revision and generation fields, batches require a VAPID public-key fingerprint, and a subscriptionOwners table tracks removal generations. No data migration is provided.
- Read delivery failures from `error: { code, message, providerStatus? }` instead of `detail`. Response bodies and native exception messages are discarded. `errorKind` and transport `statusCode` remain.
- Handle the new `WEB_PUSH_INVALID_ARGUMENT`, `WEB_PUSH_BROWSER_FAILED` and `WEB_PUSH_SERVICE_FAILED` codes. Error messages are fixed per code; `retryable` is removed from WebPushErrorData. The error guard rejects malformed messages and provider statuses.
- Supply nonempty user IDs and idempotency keys of at most 256 UTF-8 bytes, endpoints of at most 4096 UTF-16 code units, at most 16 allowed hosts of at most 253 UTF-8 bytes, and at most 100 supplied batch IDs before deduplication. Encoded keys and payloads are bounded before decoding and stored in canonical base64url. P-256 public keys must lie on the curve; expiration and TTL values must be finite, and expiration cannot be negative.
- Request history pages of 1–100 items with valid bounded cursors. Server row and byte budgets override caller budgets, including endCursor requests; a bounded endCursor page may return up to numItems + 1 rows.
- Expect batch continuations to commit failed status and errorCode on package errors, including invalid configuration or a changed VAPID public key. Batch options.onComplete now receives one BatchResult through the scheduled callback dispatcher instead of a NotificationResult per user. Expired-subscription reads and pruning consume the 150-subscription step budget; each new user reserves 50 candidates. Follow getBatch instead of assuming a fixed number of users per first result.
- Use control-free mailto addresses with nonempty local parts or HTTPS VAPID subjects on non-reserved hosts. Browser and worker failures now produce package errors; external click fallbacks resolve to the worker root.
- Update example-backed app identity keys to tokenIdentifier. The example publicKey query now requires authentication.

- Require exactly 32 decoded VAPID private-key bytes and a matching public key; actions verify a fixed signature probe before making push requests.
- Supply userId when removing subscriptions or reading a notification and its deliveries; mismatched owners receive false, null or an empty delivery array. Keep multi-user batch IDs private from end users.
- Preserve subscription consecutiveFailures and lastFailureAt for deliveries that make no push request, including paused, TTL-expired and expired-subscription skips.
- Reject trailing-dot endpoint hostnames and malformed allowedPushHosts patterns; wildcard suffixes require at least two nonempty DNS labels.

Remove stuck running batches after 35 days from creation. Truncate user agents without splitting surrogate pairs. Reject oversized sendRaw payloads before encoding or calling Convex, and reject notifications whose toJSON returns undefined. Generate shell-quoted CLI instructions and compile the test entry without Vite ambient declarations.
