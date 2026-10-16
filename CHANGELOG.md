# @operatornest/convex-web-push

## 0.4.0

### Minor Changes

- 857a41d: - Add subscriptions.get({ userId, endpoint }), returning the user's subscription at that endpoint (status, pushService, health and timestamps, never the endpoint or keys) or null when the endpoint is not registered to the user in the resolved test mode.
  - Add an optional endpoint to notifications.send and notifications.sendRaw that restricts fan-out to that subscription; the send returns null unless the subscription is active, unexpired and owned by the user. Notifications store the endpoint only as endpointHash, and idempotent replay compares it, so reusing a key with a different or omitted endpoint raises WEB_PUSH_IDEMPOTENCY_CONFLICT.
  - Add the users group with users.purge({ userId }), which deletes the user's subscriptions, notifications, delivery attempts and subscriptionOwners row in steps of at most 100 rows, preserving registrations and notifications created after the purge began.
  - Removal continuations stop without deleting when the user's registration generation is older than the continuation's, which happens only after users.purge deleted the owner row and a later registration recreated it.
  - The notifications table gains the optional endpointHash field; no data migration is needed.

## 0.3.0

### Minor Changes

- c5187e1: - Group client methods into subscriptions, notifications and deliveries groups that call matching component modules.
  - Breaking: subscriptions.remove, notifications.get and deliveries.list require userId; pass the authenticated user's identifier in application wrappers.
  - Breaking: remove the nested send options object; pass ttlSeconds, urgency, topic and idempotencyKey as top-level send arguments, rename ttl to ttlSeconds, and supply ttlSeconds and urgency explicitly; out-of-range or fractional lifetimes are rejected instead of clamped.
  - Name the callback argument types and validators WebPushNotificationCompleteArgs, WebPushBatchCompleteArgs, webPushNotificationCompleteArgsValidator and webPushBatchCompleteArgsValidator.
  - Configure completion callbacks through the onNotificationComplete and onBatchComplete constructor options; callbacks return null.
  - Name the component VAPID env variables WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_VAPID_SUBJECT.
  - Breaking: WEB_PUSH_VAPID_PRIVATE_KEY must decode to exactly 32 bytes; previously accepted shorter scalar encodings must be left-padded with zero bytes and re-encoded as base64url.
  - Name the browser subscription key argument applicationServerKey.
  - Raise WEB_PUSH_INVALID_ARGUMENT for caller validation failures, WEB_PUSH_NOT_CONFIGURED for VAPID configuration failures and WEB_PUSH_PROVIDER_ERROR or WEB_PUSH_NETWORK_ERROR for transport failures.
  - Store explicit testMode on subscriptions, registration generations, notifications, batches, deliveries and completion results; isolate reads and idempotency by user and test mode.
  - Registration and send validation parse every supplied component env value and reject malformed values with WEB_PUSH_NOT_CONFIGURED; config.verify reports configuration failures in its result.
  - Reject changed send arguments for an existing idempotencyKey with WEB_PUSH_IDEMPOTENCY_CONFLICT.
  - Raise WEB_PUSH_NOT_FOUND for notification, batch and delivery reads referencing missing or mismatched rows.
  - Return notificationId in example history summaries and providerStatus in delivery outcomes.
  - Omit providerStatus on simulated deliveries because no provider HTTP response exists.
  - Export SubscriptionStatus, NotificationStatus, DeliveryStatus, BatchStatus and PushService types with domain documentation.
  - Bound notification history pages and batch enqueueing, preserve refreshed subscription revisions and later registration generations, and retain fixed errors without provider bodies.
  - Breaking: notifications.sendBatch accepts at most 100 supplied user IDs before deduplication; deduplicate larger input arrays before calling it.
  - Breaking: allowedPushHosts accepts at most 16 DNS patterns of at most 253 UTF-8 bytes each; patterns must use valid DNS labels, wildcard suffixes must contain at least two labels, and trailing dots are rejected; invalid patterns raise WEB_PUSH_INVALID_ARGUMENT.
  - Breaking: userId must be non-empty, well-formed text of at most 256 UTF-8 bytes; subscription endpoints must be non-empty, well-formed text of at most 4096 UTF-16 code units, and expirationTime must be null, omitted or a finite non-negative number; invalid values raise WEB_PUSH_INVALID_ARGUMENT.
- 24f283b: - Breaking: add a config group; config.get(ctx) returns { applicationServerKey } and config.verify(ctx) verifies WebCrypto and the configured VAPID key pair without sending; verify reports malformed or mismatched VAPID configuration as ok: false with config.problem, and missing credentials also fail verification in live mode; in test mode, missing credentials permit ok: true when the WebCrypto checks pass, with config.configured: false and config.problem.
  - Breaking: client methods without argument fields take only ctx.
  - Breaking: subscriptions.getStatus returns activeCount, pausedCount and lastSuccessAt.
  - Breaking: an unset test-mode decision means live; a live operation without VAPID configuration raises WEB_PUSH_NOT_CONFIGURED.
  - Breaking: errorKind is the closed union DELIVERY_ERROR_KINDS, exported with deliveryErrorKindValidator and DeliveryErrorKind; malformed subscription keys record invalid_subscription_keys.
  - Breaking: upgrading a 0.2.0 deployment fails the schema push until the component's 0.2.0 rows are deleted; among them, deliveries with errorKind crypto_error or invalid_subscription are rejected by the closed errorKind union. No migration is provided.
  - Breaking: every entry point names the serialized subscription PushSubscriptionJSON, validated by the exported pushSubscriptionValidator.
  - Breaking: the browser permission union is PushPermission, returned by getPushPermission, and the registration selector is ServiceWorkerScopeOptions; the service worker parses payloads as Partial<PushNotification>.
  - Breaking: urlBase64ToUint8Array accepts at most 88 characters and raises WEB_PUSH_INVALID_ARGUMENT for longer input; it is no longer an unrestricted base64url decoder.
  - Breaking: generate-keys requires --subject and rejects example.com, example.net and example.org subjects.
  - Breaking: a package error in the first notifications.sendBatch step throws and stores no batch.
  - Breaking: error data carries retryable only on WEB_PUSH_PROVIDER_ERROR and WEB_PUSH_NETWORK_ERROR, and isWebPushError rejects data with unknown keys or with retryable on any other code.
  - Breaking: notifications.list forwards only numItems, cursor and endCursor from paginationOpts; the component fixes its read budgets.
  - Breaking: notifications.list requires an integer numItems from 1 to 100 and well-formed cursor text of at most 4096 characters; invalid inputs raise WEB_PUSH_INVALID_ARGUMENT.
  - Breaking: the convex-helpers peer range is ^0.1.128.
  - Breaking: Node.js 24 or newer is required; Node.js 22 is no longer supported.
  - Breaking: an idempotency key must be 1 to 128 characters from A-Z, a-z, 0-9, _ and -; any other key raises WEB_PUSH_INVALID_ARGUMENT.
  - Breaking: WEB_PUSH_INVALID_ARGUMENT has the message "An argument is missing, malformed or out of bounds." and WEB_PUSH_NETWORK_ERROR has the message "The request to the push service failed before a response arrived."; isWebPushError accepts only these messages for these codes.
  - Breaking: notifications.list rejects cursor and endCursor arrays longer than its five-value index key with WEB_PUSH_INVALID_ARGUMENT; shorter prefix cursors remain valid.
  - Delivery attempts compare the millisecond deadline before rounding the outbound TTL, so a live final fraction of a second sends with TTL 0.
  - Breaking: delivery error.retryable is true only for HTTP 429; ambiguous network failures, timeouts, HTTP 408 and 5xx store false independently of the internal retry schedule.
  - The client passes omitted optional arguments as undefined.
  - A package error in a batch continuation step, including an idempotency conflict, fails the batch after saving the users already enqueued and schedules onBatchComplete.
  - Validate ttlSeconds and the onComplete function handle before reading rows, including for users without subscriptions.
  - Open the click destination in a new window when the service worker cannot navigate an existing window or navigation is rejected.
  - Document every public browser and service worker export.
  - The copied service worker keeps empty-string payload titles and URLs, parses non-object JSON as a text body, resolves click URLs like registerPushHandlers and takes icon and badge defaults from its DEFAULTS object.
  - The example getBatch returns no null; notifications.getBatch raises WEB_PUSH_NOT_FOUND for a missing batch.
  - Document that subscriptions.getStatus counts recorded, unpaused subscriptions as active regardless of expirationTime, and that subscriptionOwners keeps one permanent row per user and test mode.
  - Push service response bodies are discarded without storage; a Content-Length above 4096 bytes cancels the body unread, and streamed bodies are canceled when the accumulated byte count exceeds 4096 or UTF-8 decoding fails.
  - The retention cron is named cleanup.
  - Breaking: cleanup deletes running batches older than 35 days; previously those batches were retained indefinitely.

## 0.2.0

### Minor Changes

## 0.1.1

### Patch Changes

- Publish from GitHub Actions through npm trusted publishing, with signed npm provenance attestations. No API or behavior changes.

## 0.1.0

### Minor Changes

- Initial release: Web Push for Convex with RFC 8291 encryption and RFC 8292 VAPID on WebCrypto; durable delivery through `@convex-dev/workpool` with TTL-aware retries and automatic pruning of dead subscriptions; bounded batch sends that continue in scheduled mutations; typed `WEB_PUSH_*` errors with an exported guard; `onComplete` callbacks as typed function handles; browser and service worker helpers; a VAPID key CLI; a runtime self-test; and an explicit test mode.
