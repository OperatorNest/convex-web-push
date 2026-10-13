# @operatornest/convex-web-push

Send VAPID-signed, RFC 8291-encrypted push messages from Convex’s Web API runtime through a durable workpool.

## Install

Use Node 24+, `convex` ^1.46.0 and `convex-helpers` ^0.1.127.

```sh
pnpm add @operatornest/convex-web-push convex convex-helpers
```

## Configure

Generate a VAPID pair and set the application’s environment variables:

```sh
pnpm exec convex-web-push generate-keys --subject '<mailto-address-or-https-url>'
pnpm exec convex env set WEB_PUSH_VAPID_PUBLIC_KEY '<generated-public-key>'
pnpm exec convex env set WEB_PUSH_VAPID_PRIVATE_KEY '<generated-private-key>'
pnpm exec convex env set WEB_PUSH_VAPID_SUBJECT '<mailto-address-or-https-url>'
```

`generate-keys` requires `--subject` and rejects reserved hosts, including `localhost`, `.test`, `.invalid`, `.local` and the `example.com`, `example.net` and `example.org` documentation domains.

Bind component env by reference in `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import { v } from "convex/values";
import webPush from "@operatornest/convex-web-push/convex.config";

const app = defineApp({
  env: {
    WEB_PUSH_VAPID_PUBLIC_KEY: v.optional(v.string()),
    WEB_PUSH_VAPID_PRIVATE_KEY: v.optional(v.string()),
    WEB_PUSH_VAPID_SUBJECT: v.optional(v.string()),
    WEB_PUSH_TEST_MODE: v.optional(v.string()),
    WEB_PUSH_MAX_PARALLELISM: v.optional(v.string()),
  },
});
app.use(webPush, {
  env: {
    WEB_PUSH_VAPID_PUBLIC_KEY: app.env.WEB_PUSH_VAPID_PUBLIC_KEY,
    WEB_PUSH_VAPID_PRIVATE_KEY: app.env.WEB_PUSH_VAPID_PRIVATE_KEY,
    WEB_PUSH_VAPID_SUBJECT: app.env.WEB_PUSH_VAPID_SUBJECT,
    WEB_PUSH_TEST_MODE: app.env.WEB_PUSH_TEST_MODE,
    WEB_PUSH_MAX_PARALLELISM: app.env.WEB_PUSH_MAX_PARALLELISM,
  },
});
export default app;
```

| Variable                     | Required                      | Default | Valid values                                                                                        |
| ---------------------------- | ----------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `WEB_PUSH_VAPID_PUBLIC_KEY`  | Live registration and sending | Unset   | Base64url P-256 public point, 65 decoded bytes                                                      |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | Live registration and sending | Unset   | Base64url private scalar, 32 decoded bytes, matching the public key                                 |
| `WEB_PUSH_VAPID_SUBJECT`     | Live registration and sending | Unset   | Control-free mailto address or HTTPS contact URI, at most 2048 UTF-16 code units, non-reserved host |
| `WEB_PUSH_TEST_MODE`         | No                            | Unset   | Exactly `true` or `false`; unset means live                                                         |
| `WEB_PUSH_MAX_PARALLELISM`   | No                            | 10      | Decimal integer 1–200                                                                               |

`readConfig` parses every supplied component env value. Blank and malformed values raise `WEB_PUSH_NOT_CONFIGURED`, including in test mode. Missing credentials never enable test mode. Client `testMode: true` or environment `true` enables simulation; client `false` cannot disable an enabled environment. Otherwise operations are live, and a live operation without VAPID configuration raises `WEB_PUSH_NOT_CONFIGURED`.

VAPID keys have no live/test marker and push services provide no shared sandbox. Test mode makes no push request with any configured pair. Live actions verify that the configured key pair matches before sending.

## Quick start

Public application functions must authenticate callers and derive `userId` from `identity.tokenIdentifier`. The component trusts application authorization. Send to other users only from authorized application functions.

```ts
import { WebPush, pushSubscriptionValidator } from "@operatornest/convex-web-push";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

const webPush = new WebPush(components.webPush);

export const getConfig = query({
  args: {},
  returns: v.object({ applicationServerKey: v.union(v.string(), v.null()) }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not signed in");
    return webPush.config.get(ctx);
  },
});

export const recordSubscription = mutation({
  args: { subscription: pushSubscriptionValidator },
  returns: v.object({ subscriptionId: v.string(), created: v.boolean() }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not signed in");
    return webPush.subscriptions.record(ctx, {
      userId: identity.tokenIdentifier,
      subscription: args.subscription,
    });
  },
});

export const notifyMe = mutation({
  args: { title: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not signed in");
    return webPush.notifications.send(ctx, {
      userId: identity.tokenIdentifier,
      notification: { title: args.title },
      ttlSeconds: 3600,
      urgency: "normal",
    });
  },
});
```

Subscribe from a button click after signing in:

```ts
import { subscribe } from "@operatornest/convex-web-push/browser";
const { applicationServerKey } = await convex.query(api.push.getConfig, {});
if (!applicationServerKey) throw new Error("Push is not configured");
const subscription = await subscribe({ applicationServerKey, serviceWorkerPath: "/sw.js" });
await convex.mutation(api.push.recordSubscription, { subscription });
```

## Concepts

Vocabulary follows the [W3C Push API](https://www.w3.org/TR/push-api/), [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030), [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291) and [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292).

| Term                                                           | Meaning                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| config                                                         | Component configuration: the applicationServerKey for browsers and runtime verification without a push request                                                                                                                        |
| subscriptions                                                  | Stored push subscriptions belonging to an application user and test mode                                                                                                                                                              |
| notifications                                                  | Stored notification payloads and their aggregate delivery progress                                                                                                                                                                    |
| deliveries                                                     | Stored attempts to submit a notification to a subscription’s push service                                                                                                                                                             |
| userId                                                         | Opaque application user identifier, derived from authenticated tokenIdentifier in public wrappers                                                                                                                                     |
| subscriptionId, notificationId, deliveryId, batchId            | Component row identifiers; endpoints identify provider subscriptions                                                                                                                                                                  |
| endpoint                                                       | HTTPS push resource URL in a PushSubscriptionJSON, the serialized W3C PushSubscription                                                                                                                                                |
| expirationTime                                                 | Push API subscription expiry in Unix milliseconds or null; stored only when known                                                                                                                                                     |
| keys, p256dh, auth                                             | Serialized P-256 encryption public key and 16-byte authentication secret                                                                                                                                                              |
| applicationServerKey                                           | VAPID public key passed to the browser’s PushManager                                                                                                                                                                                  |
| VAPID                                                          | Application server identification using a P-256 signing pair and contact URI                                                                                                                                                          |
| publicKey, privateKey                                          | A newly generated VAPID pair returned by generateVapidKeys; deployed private keys are never returned                                                                                                                                  |
| subject                                                        | RFC 8292 contact URI bound to WEB_PUSH_VAPID_SUBJECT                                                                                                                                                                                  |
| pushService                                                    | Provider inferred from the endpoint: fcm, mozilla, apple, wns or other                                                                                                                                                                |
| userAgent                                                      | Optional browser description, truncated to 256 UTF-16 code units                                                                                                                                                                      |
| notification                                                   | Display data: title, body, icon, badge, image, url, tag, renotify, requireInteraction, silent, timestamp, actions and data                                                                                                            |
| defaultTitle, defaultIcon, defaultBadge, defaultUrl            | Service worker fallback display fields and same-origin click destination                                                                                                                                                              |
| title, body                                                    | Notification heading and message text                                                                                                                                                                                                 |
| icon, badge, image                                             | Notification image URLs                                                                                                                                                                                                               |
| url                                                            | Same-origin destination opened on notification click                                                                                                                                                                                  |
| tag, renotify                                                  | Display replacement identifier and whether replacement alerts again                                                                                                                                                                   |
| requireInteraction, silent                                     | Browser display behavior; neither switches the send operation                                                                                                                                                                         |
| timestamp                                                      | Notifications API display timestamp in Unix milliseconds                                                                                                                                                                              |
| actions, action, title, icon                                   | Notification buttons with their action identifier, title and optional icon                                                                                                                                                            |
| data                                                           | Caller data serialized into the notification payload; the service worker shows the notification with `data` set to `{ url, extra }`, where `url` is the resolved click destination and `extra` is the caller data                     |
| payload, payloadEncoding                                       | UTF-8 message text or canonical base64url bytes for a custom worker                                                                                                                                                                   |
| ttlSeconds                                                     | Explicit lifetime, integer seconds 0–2419200; zero allows one attempt                                                                                                                                                                 |
| urgency                                                        | Explicit RFC 8030 priority: very-low, low, normal or high                                                                                                                                                                             |
| topic                                                          | RFC 8030 replacement identifier, 1–32 URL-safe base64 characters; separate from display tag                                                                                                                                           |
| idempotencyKey                                                 | Per-user and test-mode send key; changed arguments raise a conflict                                                                                                                                                                   |
| testMode                                                       | Resolved simulated-provider decision stored as true or false on affected rows; unset in both client and environment means live                                                                                                        |
| allowedPushHosts                                               | Up to 16 exact DNS names or wildcard DNS suffixes extending endpoint admission                                                                                                                                                        |
| paginationOpts, page, isDone, continueCursor                   | Convex pagination input and bounded stored history result                                                                                                                                                                             |
| numItems, cursor, endCursor, maximumRowsRead, maximumBytesRead | Nested Convex pagination fields; server limits override caller row and byte budgets                                                                                                                                                   |
| code, message, retryable, providerCode, errorCode              | Fixed package error identifier and sentence, provider retry eligibility and bounded provider error identifier                                                                                                                         |
| onNotificationComplete, onBatchComplete                        | Constructor options referencing internal mutations returning null                                                                                                                                                                     |
| WebPushNotificationCompleteArgs                                | Terminal notificationId, userId, testMode, status and delivery counts                                                                                                                                                                 |
| WebPushBatchCompleteArgs                                       | batchId, testMode, terminal status, total, processed, notificationIds and optional errorCode                                                                                                                                          |
| counts                                                         | queued, sent, failed and gone delivery totals                                                                                                                                                                                         |
| active, paused, gone                                           | Subscription states: recording activates, pause pauses, resume activates; expiry, provider 404/410, key rotation or cap retirement makes it gone                                                                                      |
| activeCount, pausedCount                                       | Numbers of active and paused subscriptions returned by subscriptions.getStatus                                                                                                                                                        |
| queued, partial, delivered, failed                             | Notification states: send queues; a settled subset makes it partial; no queued attempts and at least one sent makes it delivered; no sent attempts makes it failed                                                                    |
| queued, sending, retry, sent, failed, gone                     | Delivery states: enqueue queues; an eligible attempt sends; retryable failure schedules retry; provider acceptance makes it sent; permanent failure makes it failed; unavailable subscription makes it gone                           |
| running, done, failed                                          | Batch states: enqueueing starts running; all users processed makes it done; a package error in a continuation step, such as changed configuration or an idempotency conflict, makes it failed after saving the users already enqueued |
| created, removed, done                                         | Registration insertion indicator, first deletion-batch count and enqueueing/deletion completion indicator                                                                                                                             |
| total, processed, results, notificationIds                     | Batch audience size, processed count, per-user enqueue results and created notification row IDs                                                                                                                                       |
| revision, generation                                           | Registration versions protecting refreshed subscriptions and later registrations from earlier work                                                                                                                                    |
| endpointHash, vapidPublicKeyHash                               | Stored endpoint lookup hash and application server key fingerprint                                                                                                                                                                    |
| createdAt, updatedAt, sentAt, lastSuccessAt, lastFailureAt     | Unix millisecond timestamps for row creation, update, acceptance and subscription health                                                                                                                                              |
| consecutiveFailures, attempts, subscriptionRevision            | Attempt health and captured registration revision                                                                                                                                                                                     |
| providerStatus, retryAfterMs, errorKind, error                 | Provider HTTP status, retry delay in milliseconds, attempt reason from [Delivery error kinds](#delivery-error-kinds) and fixed package error data                                                                                     |
| ok, config, configured, problem, checks, name                  | Verification result, configuration presence, fixed problem and named cryptographic checks                                                                                                                                             |
| registration, serviceWorkerPath                                | Existing service worker registration or script path; default script /sw.js                                                                                                                                                            |
| granted, denied, default, unsupported                          | Browser permission state after granting, denying, before a decision or without Push API support                                                                                                                                       |

The aggregate groups are application records over the Push API subscription and RFC message-delivery concepts. Notifications describe the package’s displayed-message payload; raw messages use `notifications.sendRaw`.

### Delivery error kinds

`errorKind` is one of `DELIVERY_ERROR_KINDS`, typed `DeliveryErrorKind` and validated by `deliveryErrorKindValidator`. Kinds produced by a provider response store `providerStatus`.

| Kind                        | Meaning                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `delivery_closed`           | The delivery row is missing or already terminal when an attempt begins                                                         |
| `notification_missing`      | The delivery’s notification row no longer exists                                                                               |
| `subscription_removed`      | The delivery’s subscription row no longer exists                                                                               |
| `reassigned`                | The subscription now belongs to another user or test mode                                                                      |
| `subscription_gone`         | The subscription is gone, or the push service answered 404 or 410                                                              |
| `subscription_expired`      | The subscription’s expirationTime has passed                                                                                   |
| `subscription_paused`       | The subscription is paused                                                                                                     |
| `ttl_expired`               | ttlSeconds elapsed before an attempt, a zero ttlSeconds already had its one attempt, or the next retry would fall after expiry |
| `vapid_not_configured`      | A live attempt found VAPID configuration missing or malformed                                                                  |
| `vapid_key_mismatch`        | The configured public key differs from the one the notification was enqueued with                                              |
| `invalid_vapid_key`         | The configured private key does not import or does not match the public key                                                    |
| `endpoint_not_allowed`      | Endpoint admission rejected the subscription’s endpoint at send time                                                           |
| `payload_too_large`         | The payload exceeds the encryption bound, or the push service answered 413                                                     |
| `invalid_subscription_keys` | The subscription’s p256dh or auth key is malformed for encryption                                                              |
| `crypto_unsupported`        | A WebCrypto operation needed for encryption or signing failed                                                                  |
| `timeout`                   | The push request was aborted after its time limit                                                                              |
| `network_error`             | The push request failed without a response                                                                                     |
| `rate_limited`              | The push service answered 429                                                                                                  |
| `server_error`              | The push service answered 408 or 5xx                                                                                           |
| `vapid_rejected`            | The push service answered 401 or 403                                                                                           |
| `unexpected_redirect`       | The push service answered 3xx; redirects are never followed                                                                    |
| `bad_request`               | The push service answered any other non-2xx status                                                                             |
| `invalid_result`            | The delivery action returned a value that is not a send outcome                                                                |
| `action_failed`             | The delivery action threw                                                                                                      |
| `canceled`                  | The workpool canceled the delivery action                                                                                      |
| `max_attempts`              | Five attempts failed with retryable reasons                                                                                    |

## Service worker

Copy `node_modules/@operatornest/convex-web-push/sw/convex-web-push-sw.js` to `public/sw.js`, or bundle:

```ts
import { registerPushHandlers } from "@operatornest/convex-web-push/sw";
registerPushHandlers(self, { defaultIcon: "/icon-192.png", defaultUrl: "/" });
```

Defaults are title `Notification`, URL `/`, with icon and badge unset. Push events display notifications. Clicks focus a window already showing the destination; otherwise they navigate an open window and focus it, or open a new window when no window exists, the window cannot navigate or navigation is rejected. The shown notification’s `data` is `{ url, extra }`. Destinations must share the worker’s origin; external fallbacks resolve to `/`.

`subscribe` requests permission, waits up to 10 seconds for worker activation and replaces a subscription when its application server key changes. Browser exports also include `isSupported`, `getPushPermission`, `getSubscription`, `unsubscribe`, `urlBase64ToUint8Array` and the types `PushSubscriptionJSON`, `PushPermission`, `ServiceWorkerScopeOptions` and `SubscribeOptions`. Existing-subscription helpers use the registration covering the page unless a registration or path is supplied. `unsubscribe` returns the removed endpoint so the app can remove the stored row.

## API reference

Construct `new WebPush(component, options?)`. Options are `testMode`, `allowedPushHosts`, `onNotificationComplete` and `onBatchComplete`. Callback references must target internal mutations returning null and validated with `webPushNotificationCompleteArgsValidator` or `webPushBatchCompleteArgsValidator`.

| Method                  | Context         | Arguments                                                           | Result                                                                                                        |
| ----------------------- | --------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| subscriptions.record    | MutationContext | userId, subscription, userAgent?                                    | subscriptionId and created; refreshes by endpoint and test mode, can reassign a user                          |
| subscriptions.remove    | MutationContext | userId, endpoint                                                    | whether a matching row was removed                                                                            |
| subscriptions.removeAll | MutationContext | userId                                                              | removed and done; removes earlier generations in bounded steps                                                |
| config.get              | QueryContext    | ctx only                                                            | applicationServerKey: configured public key, or null in unconfigured test mode                                |
| config.verify           | ActionContext   | ctx only                                                            | ok, testMode, config and cryptographic checks; no push request                                                |
| subscriptions.getStatus | QueryContext    | userId                                                              | activeCount, pausedCount and lastSuccessAt?                                                                   |
| subscriptions.pause     | MutationContext | userId                                                              | active subscriptions paused                                                                                   |
| subscriptions.resume    | MutationContext | userId                                                              | paused subscriptions resumed                                                                                  |
| notifications.send      | MutationContext | userId, notification, ttlSeconds, urgency, topic?, idempotencyKey?  | notificationId or null without eligible subscriptions                                                         |
| notifications.sendRaw   | MutationContext | userId, payload, ttlSeconds, urgency, topic?, idempotencyKey?       | notificationId or null; payload is string or Uint8Array                                                       |
| notifications.sendBatch | MutationContext | userIds, notification, ttlSeconds, urgency, topic?, idempotencyKey? | batchId, results and done                                                                                     |
| notifications.get       | QueryContext    | userId, notificationId                                              | stored row; NOT_FOUND for a missing row or mismatched user/test mode                                          |
| notifications.list      | QueryContext    | userId, paginationOpts                                              | page, isDone and continueCursor, newest first                                                                 |
| notifications.getBatch  | QueryContext    | batchId                                                             | status, errorCode?, total, processed and notificationIds, NOT_FOUND for a missing row or mismatched test mode |
| deliveries.list         | QueryContext    | userId, notificationId                                              | at most 100 stored attempts, NOT_FOUND for a missing or mismatched notification                               |

Methods take `(ctx, args)`, or only `ctx` when they have no argument fields. Each group calls its same-named component module. Context types pick the matching Convex runQuery, runMutation or runAction capability.

`generateVapidKeys` creates a new pair without a component call. Types include WebPushOptions, SendOptions, PushSubscriptionJSON, PushNotification, VapidKeys, Urgency, PushService, NotificationId, SubscriptionStatus, NotificationStatus, DeliveryStatus, BatchStatus, DeliveryErrorKind, WebPushNotificationCompleteArgs and WebPushBatchCompleteArgs. Validators include pushSubscriptionValidator, deliveryErrorKindValidator, webPushNotificationCompleteArgsValidator and webPushBatchCompleteArgsValidator; DELIVERY_ERROR_KINDS lists every delivery error kind.

A repeated idempotency key returns the original row only when payload, encoding, lifetime, urgency, topic, allowed hosts and callback match. Terminal failed notifications release the key. Completion callbacks run in scheduled transactions and do not undo delivery counts when they fail. Batch callbacks run once after enqueueing finishes or fails, including an empty audience; they do not wait for delivery. A package error in the first batch step, raised inside `notifications.sendBatch`, throws and stores no batch; in a scheduled continuation it fails the batch and keeps the users already enqueued. Keep multi-user batch IDs private from end users.

## Errors

Errors are ConvexError values carrying WebPushErrorData: code, one fixed message and optional retryable, providerStatus and providerCode. Only provider and network codes carry retryable. Provider codes are bounded to 64 characters. `isWebPushError` validates the code, exact fixed message and optional details. WEB_PUSH_ERROR_CODES and both error types are exported.

| Code                             | Message                                                                               | When                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `WEB_PUSH_NOT_CONFIGURED`        | Component configuration is missing, malformed or changed during a batch.              | Missing required or malformed component env, mismatched VAPID pair or changed batch configuration |
| `WEB_PUSH_INVALID_ARGUMENT`      | An argument is empty, malformed or outside its bounds.                                | Malformed subscription/payload/topic/cursor/callback handle or out-of-bounds arguments            |
| `WEB_PUSH_NOT_FOUND`             | The referenced row does not exist for this user and test mode.                        | Referenced row does not exist for the caller and test mode                                        |
| `WEB_PUSH_IDEMPOTENCY_CONFLICT`  | The idempotency key was reused with different arguments.                              | A repeated send key has changed arguments                                                         |
| `WEB_PUSH_PROVIDER_ERROR`        | The push service rejected the message.                                                | Push service returned a failing HTTP status                                                       |
| `WEB_PUSH_NETWORK_ERROR`         | The push service request produced no response.                                        | Push request failed without a response                                                            |
| `WEB_PUSH_PAYLOAD_TOO_LARGE`     | The plaintext exceeds 3993 bytes or the encoded input exceeds 5324 UTF-16 code units. | Payload exceeds plaintext or encoded bounds                                                       |
| `WEB_PUSH_CRYPTO_UNSUPPORTED`    | The runtime cannot complete the required WebCrypto operation.                         | Required WebCrypto operation failed                                                               |
| `WEB_PUSH_UNSUPPORTED`           | Web Push is unavailable in this browser.                                              | Browser lacks Web Push APIs                                                                       |
| `WEB_PUSH_PERMISSION_DENIED`     | Notification permission was not granted.                                              | Notification permission was not granted                                                           |
| `WEB_PUSH_SERVICE_WORKER_FAILED` | A service worker operation failed; verify its scope and notification options.         | Worker registration, activation or notification operation failed                                  |
| `WEB_PUSH_BROWSER_FAILED`        | The browser could not complete the push subscription operation.                       | Browser subscription operation failed                                                             |

## Testing

Use `new WebPush(component, { testMode: true })` or `WEB_PUSH_TEST_MODE=true` to simulate acceptance; with neither, operations are live. Every affected row stores the resolved boolean; simulated deliveries omit providerStatus and make no push request. Live deliveries store false. Subscription and history indexes isolate user and test mode.

For convex-test, import `register` from `@operatornest/convex-web-push/test` and call it after `convexTest(schema, modules)`. Use fake timers and `t.finishAllScheduledFunctions(vi.runAllTimers)` to settle work. `config.verify` raises `WEB_PUSH_NOT_CONFIGURED` for malformed configuration, a live call without configuration or a configured mismatched key pair, then checks SHA-256, ECDH, the RFC 8291 vector and VAPID sign/verify. Configuration problems and check errors contain fixed messages.

## Limits and retention

| Input                                | Limit                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Payload plaintext                    | 3993 bytes                                                                                                        |
| Encoded payload input                | 5324 UTF-16 code units                                                                                            |
| User ID, idempotency key             | Nonempty, at most 256 UTF-8 bytes                                                                                 |
| Endpoint                             | At most 4096 UTF-16 code units                                                                                    |
| Subscription keys                    | Valid P-256 encryption point and 16-byte auth secret                                                              |
| Subscriptions per user and test mode | 50 active plus paused; recording retires the oldest excess                                                        |
| Allowed host pattern                 | At most 253 UTF-8 bytes; no URL, port, whitespace or trailing dot; wildcard suffixes have at least two DNS labels |
| History page size                    | 1–100 items; server budgets are numItems + 1 rows and 1 MiB, including endCursor requests                         |
| History cursor                       | At most 4096 characters; a JSON array of at most 16 primitive values                                              |
| Batch user IDs                       | At most 100 supplied IDs before deduplication                                                                     |
| Batch step                           | At most 150 subscriptions examined, reserving 50 before another user                                              |
| Delivery attempts                    | At most 5, within ttlSeconds                                                                                      |

Registration stores canonical base64url keys. Removal deletes 100 earlier-generation rows per transaction and preserves later registrations. A bounded endCursor page can return numItems + 1 rows. Expired batch candidates consume the step budget. Every batch continuation preserves test mode and checks configuration and the public-key fingerprint.

Retries use Retry-After and exponential backoff with jitter. HTTP 408, 429 and 5xx and network failures are retryable. Redirects and other failures are permanent; 404/410 retire only the attempted subscription revision. Sent means push service acceptance or simulated acceptance; it does not prove device display. Retries permit repeated delivery.

Cleanup retains terminal notifications, deliveries and batches for 7 days, removes unfinished work after 35 days and removes gone subscriptions after 7 days. Delivery deletion and cleanup use bounded continuations.

## Security

The deployed VAPID private key is read only through component env and never appears in arguments, stored rows, returns or logs. Endpoint admission runs at registration and send time; only HTTPS on allowed hosts is accepted, with no IP literals, credentials, custom ports or redirects. Encryption uses a fresh ephemeral key and salt per message. Errors retain no provider body, endpoint, payload, key or native exception text.

Public app wrappers authenticate with tokenIdentifier. Subscription revision and user/test-mode checks prevent an old completion from changing a refreshed or reassigned subscription. Rotating the application server key requires browsers to subscribe and record again. iOS Web Push requires an installed web app and a permission gesture. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Development

Use Node 24 and pnpm 12.9.1 through mise. Initialize an anonymous local backend, regenerate bindings and run:

```sh
CONVEX_AGENT_MODE=anonymous pnpm exec convex init
pnpm build:codegen
pnpm check
pnpm smoke
```

Check includes formatting, build, lint, typechecking, unused-export checks, source checks and coverage. Smoke installs a packed package into an isolated anonymous local backend. Neither smoke nor stubbed tests prove live push service or physical browser behavior. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

MIT; see [LICENSE](LICENSE).
