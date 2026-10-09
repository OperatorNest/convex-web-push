# 0005: maxParallelism is component configuration

## Context

Workpool's `maxParallelism` is global to the pool, but it used to be passed on each enqueue, so any
send that omitted it reset the pool to the default.

## Decision

The value comes only from the component env var `WEB_PUSH_MAX_PARALLELISM` (an integer from 1 to
200, default 10). Every enqueue passes that same value. An invalid value fails sends with
`WEB_PUSH_NOT_CONFIGURED`. The client no longer has a `maxParallelism` option.

## Consequences

Apps bind the env var like the VAPID ones. Pool-wide tuning cannot differ per send.
