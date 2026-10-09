# 0003: Flat client method names

## Context

Grouped methods such as `client.orders.create(ctx, args)` suit larger clients. The Web Push
client is small and its methods already read as one list of verbs on one object.

## Decision

Keep flat names (`recordSubscription`, `sendNotification`, `getStatusForUser`, ...). Every method
takes `(ctx, args)` with `args` an object, and there are no alias methods.

## Consequences

If the surface grows, group it then; that would be a breaking change before 1.0.
