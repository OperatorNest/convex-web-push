# 0003: Aggregate client methods

The client exposes `config`, `subscriptions`, `notifications` and `deliveries`. Each group calls only its same-named component module. Methods take `(ctx, args)` or only `ctx` when they have no arguments; `config.get` and `config.verify` take only `ctx`. Notification lifetime and urgency are explicit send arguments. Completion callbacks are constructor options `onNotificationComplete` and `onBatchComplete`, each returning null.

Component configuration is its own aggregate because it belongs to no subscription, notification or delivery row. `config.get` returns `{ applicationServerKey }` for browser subscription creation. `config.verify` verifies configured key-pair agreement, encryption and signing without sending a push message. `subscriptions.getStatus` returns `activeCount`, `pausedCount` and optional `lastSuccessAt`; count fields name their unit. `generateVapidKeys` remains a standalone named export because it makes no component call.
