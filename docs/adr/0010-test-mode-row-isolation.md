# 0010: Test mode row isolation

Subscriptions, registration generations, notifications, notification batches and deliveries store a boolean `testMode`. User indexes include `testMode` immediately after `userId`. Endpoint indexes include test mode so simulated registrations cannot reassign live subscriptions. Reads and writes select the resolved test mode: client `testMode: true` or `WEB_PUSH_TEST_MODE=true` enables it, so an enabled environment cannot be disabled by client options. When neither enables it, operations are live, and a live operation without VAPID configuration raises `WEB_PUSH_NOT_CONFIGURED`. Missing credentials never enable test mode.

Notification idempotency keys are scoped to user and test mode. Repeating a send with changed payload, encoding, lifetime, urgency, topic, allowed hosts or callback raises `WEB_PUSH_IDEMPOTENCY_CONFLICT`. A terminal failed notification releases its key for another send.
