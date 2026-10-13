---
"@operatornest/convex-web-push": minor
---

- Replace flat client methods with subscriptions, notifications and deliveries groups that call matching component modules.
- Require ttlSeconds and urgency as top-level send arguments and reject out-of-range or fractional lifetimes instead of clamping them.
- Rename callback argument types and validators to WebPushNotificationCompleteArgs, WebPushBatchCompleteArgs, vWebPushNotificationCompleteArgs and vWebPushBatchCompleteArgs.
- Move completion callbacks to onNotificationComplete and onBatchComplete constructor options returning null.
- Rename component VAPID env variables to WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_VAPID_SUBJECT.
- Rename the browser subscription key argument to applicationServerKey and subscription types to PushSubscription and PushSubscriptionJSON.
- Replace caller validation codes with WEB_PUSH_INVALID_ARGUMENT, VAPID configuration failures with WEB_PUSH_NOT_CONFIGURED and transport failures with WEB_PUSH_PROVIDER_ERROR or WEB_PUSH_NETWORK_ERROR.
- Store explicit testMode on subscriptions, registration generations, notifications, batches, deliveries and completion results; isolate reads and idempotency by user and test mode.
- Require a client or environment testMode decision and reject every malformed component env value.
- Reject changed send arguments for an existing idempotencyKey with WEB_PUSH_IDEMPOTENCY_CONFLICT.
- Raise WEB_PUSH_NOT_FOUND for notification, batch and delivery reads referencing missing or mismatched rows.
- Return notificationId in example history summaries and providerStatus in delivery outcomes.
- Omit providerStatus on simulated deliveries because no provider HTTP response exists.
- Export SubscriptionStatus, NotificationStatus, DeliveryStatus, BatchStatus and PushService types with domain documentation.
- Read the application server key through subscriptions.readApplicationServerKey and verify WebCrypto through deliveries.verify.
- Bound notification history pages and batch enqueueing, preserve refreshed subscription revisions and later registration generations, and retain fixed errors without provider bodies.
