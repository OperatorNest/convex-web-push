---
"@operatornest/convex-web-push": minor
---

- Add subscriptions.get({ userId, endpoint }), returning the user's subscription at that endpoint (status, pushService, health and timestamps, never the endpoint or keys) or null when the endpoint is not registered to the user in the resolved test mode.
- Add an optional endpoint to notifications.send and notifications.sendRaw that restricts fan-out to that subscription; the send returns null unless the subscription is active, unexpired and owned by the user. Notifications store the endpoint only as endpointHash, and idempotent replay compares it, so reusing a key with a different or omitted endpoint raises WEB_PUSH_IDEMPOTENCY_CONFLICT.
- Add the users group with users.purge({ userId }), which deletes the user's subscriptions, notifications, delivery attempts and subscriptionOwners row in steps of at most 100 rows, preserving registrations and notifications created after the purge began.
- Removal continuations stop without deleting when the user's registration generation is older than the continuation's, which happens only after users.purge deleted the owner row and a later registration recreated it.
- The notifications table gains the optional endpointHash field; no data migration is needed.
