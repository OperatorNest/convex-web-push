# 0009: Send configuration and row ownership

VAPID private keys decode to exactly 32 bytes. Importing a signing key verifies a signature over a fixed probe with the configured public key before any push request. A mismatched pair produces WEB_PUSH_NOT_CONFIGURED.

Send validation, including the onComplete function-handle format and ttlSeconds bounds, runs before any row is read. A package error in any batch step, from configuration, validation, the public-key fingerprint check or per-user enqueueing such as an idempotency conflict, fails the batch: the step persists nextIndex and notificationIds for the users already enqueued, then commits failed status and errorCode and schedules onBatchComplete. The first step runs inside `notifications.sendBatch`, so it throws the package error instead and its transaction rolls back, leaving no batch row. Non-package errors throw. Terminal batches never resume. notifications.getBatch returns status and optional errorCode. The constructor’s onBatchComplete receives one WebPushBatchCompleteArgs after enqueueing completes or fails, through the scheduled callback dispatcher used by single-user notifications. It does not wait for deliveries. Single-user callbacks receive WebPushNotificationCompleteArgs.

Subscription removal requires userId and matching ownership. Notification and delivery reads require userId and raise WEB_PUSH_NOT_FOUND for a different user or test mode. Batch reads remain ID-only; apps keep multi-user batch IDs private from end users. Recording an existing endpoint may reassign it to another user.

Subscription consecutiveFailures and lastFailureAt change only after a push request; test-mode success resets consecutiveFailures. Eligibility skips still settle delivery counts and retire expired subscriptions.

Endpoint admission rejects trailing hostname dots. Allowed host patterns are exact DNS hostnames or wildcard suffixes with at least two nonempty DNS labels. Labels contain letters, digits and interior hyphens.
