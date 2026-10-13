# 0010: Test mode row isolation

Subscriptions, registration generations, notifications, notification batches and deliveries store a boolean `testMode`. User indexes include `testMode` immediately after `userId`. Endpoint indexes include test mode so simulated registrations cannot reassign live subscriptions. Reads and writes select the client’s resolved test mode; an enabled environment cannot be disabled by client options. Missing client and environment decisions raise `WEB_PUSH_INVALID_ARGUMENT`.

Notification idempotency keys are scoped to user and test mode. Repeating a send with changed payload, encoding, lifetime, urgency, topic, allowed hosts or callback raises `WEB_PUSH_IDEMPOTENCY_CONFLICT`. A terminal failed notification releases its key for another send.
