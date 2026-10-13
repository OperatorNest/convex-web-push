# 0003: Aggregate client methods

The client exposes `subscriptions`, `notifications` and `deliveries`. Each group calls only its same-named component module. Methods take `(ctx, args)` or only `ctx` when they have no arguments. Notification lifetime and urgency are explicit send arguments. Completion callbacks are constructor options `onNotificationComplete` and `onBatchComplete`, each returning null.

`subscriptions.readApplicationServerKey` reads component configuration for browser subscription creation. `deliveries.verify` verifies encryption, signing and configured key-pair agreement without sending a push message. `generateVapidKeys` remains a standalone named export because it makes no component call.
