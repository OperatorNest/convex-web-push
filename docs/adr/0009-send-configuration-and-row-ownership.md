# 0009: Send configuration and row ownership

VAPID private keys decode to exactly 32 bytes. Importing a signing key verifies a signature over a fixed probe with the configured public key before any push request. A mismatched pair produces WEB_PUSH_INVALID_VAPID_KEY.

A batch continuation commits failed status and errorCode when send validation produces a package error. Non-package errors throw. Terminal batches never resume. getBatch returns status and optional errorCode. Batch onComplete receives one BatchResult after enqueueing completes or fails, through the scheduled callback dispatcher used by single-user notifications. It does not wait for deliveries. Single-user callbacks receive NotificationResult.

Subscription removal requires userId and matching ownership. Notification and delivery reads require userId and return null or an empty array for a different owner. Batch reads remain ID-only; apps keep multi-user batch IDs private from end users. Recording an existing endpoint may reassign it to another user.

Subscription consecutiveFailures and lastFailureAt change only after a push request; test-mode success resets consecutiveFailures. Eligibility skips still settle delivery counts and retire expired subscriptions.

Endpoint admission rejects trailing hostname dots. Allowed host patterns are exact DNS hostnames or wildcard suffixes with at least two nonempty DNS labels. Labels contain letters, digits and interior hyphens.
