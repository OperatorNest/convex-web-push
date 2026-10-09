# 0006: Workpool never retries; the component plans retries

## Context

Retries must respect `Retry-After`, the TTL and the retryable/permanent classification, none of
which workpool's own retry knows about.

## Decision

The pool is created with `retryActionsByDefault: false` and enqueues carry no per-call `retry`
option (it would be redundant). `deliveries.onComplete` re-enqueues retryable results with
`runAfter`.

## Consequences

Retry behaviour is one function, `planRetry`, covered by unit tests.
