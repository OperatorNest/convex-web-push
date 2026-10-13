# 0006: Retry ownership

Workpool has `retryActionsByDefault: false`. `deliveries.onComplete` applies `planRetry` and schedules retryable attempts with `runAfter`. Retries respect Retry-After, five attempts and TTL expiry; enqueues accept no per-call retry option.
