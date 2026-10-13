# @operatornest/convex-web-push

[![Release](https://github.com/OperatorNest/convex-web-push/actions/workflows/release.yml/badge.svg)](https://github.com/OperatorNest/convex-web-push/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@operatornest/convex-web-push)](https://www.npmjs.com/package/@operatornest/convex-web-push)

Send VAPID-signed, RFC 8291-encrypted Web Push notifications from Convex's default runtime using WebCrypto and `fetch`. Delivery runs through `@convex-dev/workpool`, with retries, subscription pruning, per-user pause, history and opt-in test mode.

## Install and configure

Consumers need Node 24+, `convex` ^1.46.0 and `convex-helpers` ^0.1.127. Workpool is the package's runtime dependency.

```sh
pnpm add @operatornest/convex-web-push convex convex-helpers
pnpm exec convex-web-push generate-keys --subject mailto:you@example.com
pnpm exec convex env set VAPID_PUBLIC_KEY '<generated-public-key>'
pnpm exec convex env set VAPID_PRIVATE_KEY '<generated-private-key>'
pnpm exec convex env set VAPID_SUBJECT 'mailto:you@example.com'
```

Keep the deployed VAPID private key secret. Use a `mailto:` address with a nonempty local part or an HTTPS contact URL; control characters and hosts ending in `localhost`, `.local`, `.invalid` or `.test` are rejected.

In `convex/convex.config.ts`, bind all component variables by reference:

```ts
import { defineApp } from "convex/server";
import { v } from "convex/values";
import webPush from "@operatornest/convex-web-push/convex.config";

const app = defineApp({
  env: {
    VAPID_PUBLIC_KEY: v.optional(v.string()),
    VAPID_PRIVATE_KEY: v.optional(v.string()),
    VAPID_SUBJECT: v.optional(v.string()),
    WEB_PUSH_TEST_MODE: v.optional(v.string()),
    WEB_PUSH_MAX_PARALLELISM: v.optional(v.string()),
  },
});
app.use(webPush, {
  env: {
    VAPID_PUBLIC_KEY: app.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: app.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: app.env.VAPID_SUBJECT,
    WEB_PUSH_TEST_MODE: app.env.WEB_PUSH_TEST_MODE,
    WEB_PUSH_MAX_PARALLELISM: app.env.WEB_PUSH_MAX_PARALLELISM,
  },
});
export default app;
```

| Component env              | Default | Accepted value                                                                                                            |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`         | unset   | Base64url-encoded 65-byte P-256 public point; required for non-test sends.                                                |
| `VAPID_PRIVATE_KEY`        | unset   | Base64url-encoded exactly 32-byte private scalar matching the public key; required for non-test sends.                    |
| `VAPID_SUBJECT`            | unset   | Contact URI, at most 2048 UTF-16 code units; required for non-test sends.                                                 |
| `WEB_PUSH_TEST_MODE`       | off     | Exactly `true` enables test mode.                                                                                         |
| `WEB_PUSH_MAX_PARALLELISM` | 10      | Unset or blank uses 10; otherwise integer 1–200, shared across the workpool. Invalid values fail sends even in test mode. |

`new WebPush(components.webPush, { testMode?, allowedPushHosts? })` accepts two constructor options. `testMode` defaults to false; either `testMode: true` or `WEB_PUSH_TEST_MODE=true` enables test mode. `allowedPushHosts` defaults to an empty extension of the built-in allowlist and accepts at most 16 exact DNS hostnames or `*.` followed by at least two DNS labels, each pattern at most 253 UTF-8 bytes. Labels contain letters, digits and interior hyphens; empty labels, trailing dots, whitespace, URLs and ports are rejected.

## Record subscriptions

The component trusts your app's authorization. Public app functions derive `userId` from `ctx.auth`, including the issuer through `tokenIdentifier`. Functions that send to other users or read their rows must authorize that access in your app.

In `convex/push.ts`:

```ts
import { vNotificationResult, vWebPushSubscription, WebPush } from "@operatornest/convex-web-push";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

const webPush = new WebPush(components.webPush);

async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not signed in");
  return identity.tokenIdentifier;
}

export const publicKey = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    await requireUserId(ctx);
    return webPush.getPublicKey(ctx);
  },
});

export const saveSubscription = mutation({
  args: { subscription: vWebPushSubscription, userAgent: v.optional(v.string()) },
  returns: v.object({ subscriptionId: v.string(), created: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return webPush.recordSubscription(ctx, {
      userId,
      subscription: args.subscription,
      userAgent: args.userAgent,
    });
  },
});

export const removeSubscription = mutation({
  args: { endpoint: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { endpoint }) => {
    const userId = await requireUserId(ctx);
    return webPush.removeSubscription(ctx, { endpoint, userId });
  },
});
```

Call the browser helper from a button click after signing in:

```ts
import { subscribe } from "@operatornest/convex-web-push/browser";

const vapidPublicKey = await convex.query(api.push.publicKey, {});
if (!vapidPublicKey) throw new Error("Push is not configured");
const subscription = await subscribe({ vapidPublicKey, serviceWorkerPath: "/sw.js" });
await convex.mutation(api.push.saveSubscription, { subscription, userAgent: navigator.userAgent });
```

`subscribe` requests permission, registers or reuses a worker, waits up to 10 seconds for activation and replaces an existing subscription if its VAPID key differs. `registration` supplies an existing registration; otherwise `serviceWorkerPath` defaults to `/sw.js`. Serve the worker from the page's origin with a scope covering that page.

`/browser` also exports `isSupported()`, `permissionState()`, `urlBase64ToUint8Array(key)`, `getSubscription(options?)` and `unsubscribe(options?)`. The last two accept the same registration options and return null in unsupported environments. Without a registration or path, they use the registration covering the current page. `unsubscribe` returns the removed endpoint. Sync the browser subscription with your server on each app load.

## Service worker

Copy `node_modules/@operatornest/convex-web-push/sw/convex-web-push-sw.js` to `public/sw.js`, or bundle this code:

```ts
import { registerPushHandlers } from "@operatornest/convex-web-push/sw";
registerPushHandlers(self, { defaultIcon: "/icon-192.png", defaultUrl: "/" });
```

Handler defaults: `defaultTitle` is `Notification`, `defaultUrl` is `/`, and `defaultIcon` and `defaultBadge` are unset. Push events display a notification. Clicks focus a matching window, navigate another window or open one; payload URLs and fallback URLs must share the worker's origin. External fallbacks resolve to `/`.

## Send

Add these internal functions to `convex/push.ts`:

```ts
export const onNotificationComplete = internalMutation({
  args: vNotificationResult,
  returns: v.null(),
  handler: () => null,
});

export const notifyOrderShipped = internalMutation({
  args: { userId: v.string(), orderId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, { userId, orderId }): Promise<string | null> =>
    webPush.sendNotification(ctx, {
      userId,
      notification: {
        title: "Your order shipped",
        url: `/orders/${orderId}`,
        tag: `order-${orderId}`,
      },
      options: {
        ttl: 3600,
        idempotencyKey: `shipped-${orderId}`,
        onComplete: internal.push.onNotificationComplete,
      },
    }),
});
```

`onComplete` must be an internal mutation accepting `NotificationResult`. It runs in a scheduled transaction after every delivery finishes; its failure does not undo delivery counts. If no subscription is eligible, a send returns null without scheduling the callback. If every delivery fails or is gone, the idempotency key is released. Otherwise repeated sends with the same key return the original notification until cleanup removes it.

| Send option      | Default  | Meaning                                                                           |
| ---------------- | -------- | --------------------------------------------------------------------------------- |
| `ttl`            | 86400    | Finite seconds, floored and clamped to 0–2419200. Zero permits one attempt.       |
| `urgency`        | `normal` | `very-low`, `low`, `normal` or `high`.                                            |
| `topic`          | unset    | 1–32 characters of `A-Za-z0-9_-`; replaces a pending message at the push service. |
| `idempotencyKey` | unset    | Nonempty per-user key, at most 256 UTF-8 bytes.                                   |
| `onComplete`     | unset    | Internal completion mutation reference.                                           |

Notification shape: `{ title, body?, icon?, badge?, image?, url?, tag?, renotify?, requireInteraction?, silent?, timestamp?, actions?, data? }`. The serialized JSON or raw payload must fit 3993 bytes. For display replacement, use notification `tag` (`notification.tag` in the send argument); `topic` does not deduplicate messages already displayed. Retries provide at-least-once delivery.

## Client methods

| Method                                                            | Context  | Result                                                                                                  |
| ----------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `recordSubscription(ctx, { userId, subscription, userAgent? })`   | mutation | `{ subscriptionId, created }`; upserts by endpoint and can reassign its owner.                          |
| `removeSubscription(ctx, { endpoint, userId })`                   | mutation | Whether it removed a row owned by `userId`.                                                             |
| `removeAllForUser(ctx, { userId })`                               | mutation | `{ removed, done }`; counts the first 100-row batch, schedules the rest, preserves later registrations. |
| `sendNotification(ctx, { userId, notification, options? })`       | mutation | Notification ID or null.                                                                                |
| `sendNotificationBatch(ctx, { userIds, notification, options? })` | mutation | `{ batchId, results, done }`; at most 100 supplied IDs, duplicates removed.                             |
| `sendRaw(ctx, { userId, payload, options? })`                     | mutation | Notification ID or null; `payload` is a string or Uint8Array for a custom worker.                       |
| `getNotification(ctx, { notificationId, userId })`                | query    | Stored notification or null when absent or owned by another user.                                       |
| `getBatch(ctx, { batchId })`                                      | query    | `{ status, errorCode?, total, processed, notificationIds }` or null.                                    |
| `getDeliveries(ctx, { notificationId, userId })`                  | query    | Up to 100 delivery rows; an empty array when the notification is absent or owned by another user.       |
| `getNotificationsForUser(ctx, { userId, paginationOpts })`        | query    | History newest first; page size 1–100, server budget `numItems + 1` rows even with `endCursor`.         |
| `getStatusForUser(ctx, { userId })`                               | query    | `{ subscriptions, paused, lastSuccessAt? }`; reads at most 50 rows of each live status.                 |
| `pauseNotifications(ctx, { userId })`                             | mutation | Number of active subscriptions paused.                                                                  |
| `resumeNotifications(ctx, { userId })`                            | mutation | Number of paused subscriptions resumed.                                                                 |
| `getPublicKey(ctx)`                                               | query    | Configured public key or null.                                                                          |
| `selfTest(ctx)`                                                   | action   | `{ ok, testMode, config, checks }`; sanitized WebCrypto diagnostics.                                    |

Batch steps examine at most 150 subscriptions, counting expired rows and their pruning writes. Each new user reserves room for 50 candidates before reading; a user deferred for insufficient room continues in a scheduled transaction. Test mode is resolved once. Every step rechecks parallelism and required VAPID configuration and refuses a changed public-key fingerprint. A package error in a continuation commits `status: "failed"` and `errorCode`; failed batches never resume. For larger audiences, call the batch method from an action once per 100 IDs so each call commits separately.

Batch IDs authorize reads of a multi-user batch and must not be exposed to end users. For `sendNotificationBatch`, `options.onComplete` accepts `BatchResult` through an internal mutation validated with `vBatchResult`. It runs once after enqueueing finishes or a continuation fails, through the same scheduled callback dispatcher as notification completion. Its result is `{ batchId, status: "done" | "failed", total, processed, notificationIds, errorCode? }`; `done` describes enqueueing, not delivery. Batch callbacks run even for an empty audience. Single-user sends continue to use `NotificationResult`.

Before an action sends its first push request, importing the VAPID private key signs a fixed probe and verifies it with the configured public key. Pair mismatch produces `WEB_PUSH_INVALID_VAPID_KEY` without making a push request.

User IDs must be nonempty and at most 256 UTF-8 bytes. Endpoints are limited to 4096 UTF-16 code units. Registration validates a P-256 curve point and a 16-byte auth secret, canonicalizes their base64url encoding, rejects nonfinite or negative expiration times, and keeps at most 50 active plus paused subscriptions per user by retiring the oldest. `userAgent` is truncated to 256 UTF-16 code units without splitting a surrogate pair.

Notification statuses: `queued`, `partial`, `delivered` (at least one delivery sent and none queued), `failed` (none sent and none queued). Counts are `queued`, `sent`, `failed`, `gone`. Sent means HTTP 2xx acceptance by the push service, or test-mode completion; it does not prove display on a device.

## Errors

Thrown package errors are `ConvexError<{ code, message, providerStatus? }>` with one fixed message per code. `isWebPushError(error)` checks the code, string message and optional HTTP status. Delivery failures store the same data in `error`, alongside `errorKind` and transport `statusCode`; response bodies, native exception messages and endpoint URLs are never copied into error data.

| Code                             | Fixed message                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `WEB_PUSH_NOT_CONFIGURED`        | VAPID settings are missing or invalid, changed during a batch, or WEB_PUSH_MAX_PARALLELISM is invalid. |
| `WEB_PUSH_INVALID_ARGUMENT`      | An argument is empty, malformed or outside its bounds.                                                 |
| `WEB_PUSH_INVALID_SUBSCRIPTION`  | The endpoint, P-256 public key, auth secret or expiration is invalid.                                  |
| `WEB_PUSH_INVALID_PAYLOAD`       | The notification cannot be serialized to JSON or the raw payload is malformed base64url.               |
| `WEB_PUSH_PAYLOAD_TOO_LARGE`     | The plaintext exceeds 3993 bytes or the encoded input exceeds 5324 UTF-16 code units.                  |
| `WEB_PUSH_INVALID_TOPIC`         | The topic must contain 1 to 32 characters from A-Z, a-z, 0-9, _ or -.                                  |
| `WEB_PUSH_BATCH_TOO_LARGE`       | A batch must contain at most 100 supplied user IDs.                                                    |
| `WEB_PUSH_INVALID_VAPID_KEY`     | The VAPID keys are malformed, cannot be imported or do not form a matching pair.                       |
| `WEB_PUSH_CRYPTO_UNSUPPORTED`    | The runtime cannot complete the required WebCrypto operation.                                          |
| `WEB_PUSH_UNSUPPORTED`           | Web Push is unavailable in this browser.                                                               |
| `WEB_PUSH_PERMISSION_DENIED`     | Notification permission was not granted.                                                               |
| `WEB_PUSH_SERVICE_WORKER_FAILED` | A service worker operation failed; verify its scope and notification options.                          |
| `WEB_PUSH_BROWSER_FAILED`        | The browser could not complete the push subscription operation.                                        |
| `WEB_PUSH_SERVICE_FAILED`        | The push attempt failed or the subscription is no longer eligible.                                     |

Also exported: `WEB_PUSH_ERROR_CODES`, `WebPushErrorCode`, `WebPushErrorData`, `generateVapidKeys()`, `VapidKeys`, `vNotificationResult`, `vWebPushSubscription`, `NotificationResult`, `BatchResult`, `vBatchResult`, `BatchSendOptions`, `WebPushSubscription`, `PushNotification`, `SendOptions`, `WebPushOptions`, `Urgency`, `NotificationId`, `MAX_PLAINTEXT_BYTES`.

## Verification and retention

Run `selfTest` through an internal action after deploying. It checks SHA-256, ECDH, the RFC 8291 Appendix A vector, VAPID sign/verify and configured key-pair agreement. It returns configuration problems and fixed check error messages, never the deployed private key. `generateVapidKeys` intentionally returns a newly generated pair.

For `convex-test`, import `register` from `@operatornest/convex-web-push/test` and call `register(t)` after `convexTest(schema, modules)`. Use fake timers and `t.finishAllScheduledFunctions(vi.runAllTimers)` to finish scheduled deliveries.

Test mode tags rows `testMode: true`, completes deliveries with `statusCode: 0` and calls no push service. Missing credentials never enable it. Local smoke verifies the real anonymous Convex runtime; tests stub push services. No live-provider or physical-browser verification is claimed. iOS Web Push requires an installed web app and a user gesture for permission.

Retries: 429, 408, 5xx, network failures and timeouts use exponential backoff with jitter, up to five attempts, respecting Retry-After and remaining TTL. A retry at or after TTL expiry is discarded. Other HTTP failures and redirects are permanent; 404/410 retire the attempted subscription revision. A completion from an earlier registration cannot retire a refreshed row. Skips and failures before a push request leave `consecutiveFailures` and `lastFailureAt` unchanged; an expired subscription is still retired.

Cleanup runs every six hours, with at most 500 deletes per transaction:

- Finished deliveries, notifications and batches expire after seven days from creation.
- Unfinished deliveries, notifications and batches expire after 35 days from creation.
- Gone subscriptions expire seven days after `updatedAt`.

The deployed private key lives only in component env. Subscription endpoints are sensitive capability URLs. Admission requires HTTPS, an allowed hostname, no credentials, custom port, IP literal or trailing hostname dot; sending rechecks admission and never follows redirects. The built-in hosts cover FCM, Mozilla, Apple and WNS. Extend them only with push services you trust.

Report vulnerabilities through [SECURITY.md](https://github.com/OperatorNest/convex-web-push/blob/main/SECURITY.md). Contributors: [CONTRIBUTING.md](https://github.com/OperatorNest/convex-web-push/blob/main/CONTRIBUTING.md), [AGENTS.md](https://github.com/OperatorNest/convex-web-push/blob/main/AGENTS.md), [ADRs](https://github.com/OperatorNest/convex-web-push/tree/main/docs/adr).

MIT. Maintained by [OperatorNest](https://github.com/OperatorNest) and [@ravalikamaker](https://github.com/ravalikamaker).
