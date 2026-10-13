---
"@operatornest/convex-web-push": minor
---

- Group client methods into subscriptions, notifications and deliveries groups that call matching component modules.
- Require ttlSeconds and urgency as top-level send arguments and reject out-of-range or fractional lifetimes instead of clamping them.
- Name the callback argument types and validators WebPushNotificationCompleteArgs, WebPushBatchCompleteArgs, webPushNotificationCompleteArgsValidator and webPushBatchCompleteArgsValidator.
- Configure completion callbacks through the onNotificationComplete and onBatchComplete constructor options; callbacks return null.
- Name the component VAPID env variables WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_VAPID_SUBJECT.
- Name the browser subscription key argument applicationServerKey.
- Raise WEB_PUSH_INVALID_ARGUMENT for caller validation failures, WEB_PUSH_NOT_CONFIGURED for VAPID configuration failures and WEB_PUSH_PROVIDER_ERROR or WEB_PUSH_NETWORK_ERROR for transport failures.
- Store explicit testMode on subscriptions, registration generations, notifications, batches, deliveries and completion results; isolate reads and idempotency by user and test mode.
- Reject every malformed component env value with WEB_PUSH_NOT_CONFIGURED.
- Reject changed send arguments for an existing idempotencyKey with WEB_PUSH_IDEMPOTENCY_CONFLICT.
- Raise WEB_PUSH_NOT_FOUND for notification, batch and delivery reads referencing missing or mismatched rows.
- Return notificationId in example history summaries and providerStatus in delivery outcomes.
- Omit providerStatus on simulated deliveries because no provider HTTP response exists.
- Export SubscriptionStatus, NotificationStatus, DeliveryStatus, BatchStatus and PushService types with domain documentation.
- Bound notification history pages and batch enqueueing, preserve refreshed subscription revisions and later registration generations, and retain fixed errors without provider bodies.
