# 0013: Delivery deadlines, retry safety and cursor bounds

A positive notification lifetime ends at `createdAt + ttlSeconds * 1000`. An attempt at or after that millisecond deadline is `ttl_expired`. Before the deadline, the outbound TTL is the remaining seconds rounded down, including zero during the final fraction of a second. An explicit zero lifetime permits one attempt.

Delivery error `retryable` means both that the failure may be transient and that repeating the identical call cannot create a second provider effect. Push POSTs carry no provider-deduplicated key. Only HTTP 429 satisfies both conditions. Network failures, timeouts, HTTP 408 and 5xx store `retryable: false` because the request may already have produced an effect; other refusals and unexpected results also store false. Completion preserves the send outcome's flag; a failed action or missing error data defaults to false. The internal schedule still uses `planRetry` for network failures, timeouts, HTTP 408, 429 and 5xx. Repeated delivery remains possible.

Notification history validates both cursor and endCursor against the `by_userId_and_testMode_and_createdAt` index key: three declared fields plus `_creationTime` and `_id`, totaling five values. A longer array raises `WEB_PUSH_INVALID_ARGUMENT`; a shorter array remains a valid prefix bound. This replaces the sixteen-value bound without compatibility code.
