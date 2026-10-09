# @operatornest/convex-web-push

[![Release](https://github.com/OperatorNest/convex-web-push/actions/workflows/release.yml/badge.svg)](https://github.com/OperatorNest/convex-web-push/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@operatornest/convex-web-push)](https://www.npmjs.com/package/@operatornest/convex-web-push)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Web Push for Convex. Send VAPID-signed, end-to-end encrypted browser notifications from your Convex backend, with durable delivery, retries that respect push-service rules, and automatic pruning of dead subscriptions.

Verified against: RFC 8291 (including the Appendix A test vector, reproduced byte for byte by `selfTest`), RFC 8292 (VAPID) and RFC 8030, on the local Convex backend through `pnpm smoke`. Real push services (FCM, Mozilla, Apple, WNS) are not called by any test; see [Known limitations](#known-limitations).

- **No Node.js, no `web-push` package.** Encryption and signing use only WebCrypto, so everything runs in Convex's default runtime.
- **Durable delivery.** Sends fan out through [`@convex-dev/workpool`](https://www.convex.dev/components/workpool) with bounded parallelism.
- **Correct error handling.** Every push response is classified as `retryable`, `permanent` or `gone`. `Retry-After` is honoured and a message is never retried past its TTL. `404`/`410` mark the subscription gone.
- **Safe by default.** Endpoints must be `https` URLs on known push services, plus an `allowedPushHosts` extension, so the component cannot be used as an open HTTP relay.
- **Idempotent sends**, per-user pause/resume, paginated history, a retention cron and an explicit test mode.
- **Browser helpers and a service worker**, plus a CLI to generate VAPID keys.

## Install

```sh
pnpm add @operatornest/convex-web-push convex convex-helpers
```

Peers: `convex` `^1.46.0` and `convex-helpers` `^0.1.106`. `@convex-dev/workpool` is installed with the package.

## Configure

Generate VAPID keys and set them on your deployment:

```sh
npx @operatornest/convex-web-push generate-keys --subject mailto:you@example.com
npx convex env set VAPID_PUBLIC_KEY <value>
npx convex env set VAPID_PRIVATE_KEY <value>
npx convex env set VAPID_SUBJECT mailto:you@example.com
```

Keep the private key secret and never commit it. The subject must be a real `mailto:` address or an `https:` URL; `localhost`, `.local`, `.invalid` and `.test` hosts are rejected.

Bind the variables by reference when you install the component:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import { v } from "convex/values";
import webPush from "@operatornest/convex-web-push/convex.config.js";

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

| Variable                   | Required  | Purpose                                                                                                                                                                                                                                  |
| -------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`         | for sends | 65-byte public key, base64url. Given to browsers as `applicationServerKey`.                                                                                                                                                              |
| `VAPID_PRIVATE_KEY`        | for sends | 32-byte private scalar, base64url.                                                                                                                                                                                                       |
| `VAPID_SUBJECT`            | for sends | `mailto:` or `https:` contact URI sent with every request.                                                                                                                                                                               |
| `WEB_PUSH_TEST_MODE`       | no        | `true` opts in to test mode (see [Testing](#testing)).                                                                                                                                                                                   |
| `WEB_PUSH_MAX_PARALLELISM` | no        | Integer 1 to 200, default 10. Concurrent deliveries across the component's workpool. Workpool applies it globally, so it is component configuration, never a per-send option. Invalid values make sends throw `WEB_PUSH_NOT_CONFIGURED`. |

The `VAPID_*` names are the ecosystem-standard ones ([ADR 0002](docs/adr/0002-env-names-and-live-key-refusal.md)).

## Quick start

### 1. Record subscriptions (signed-in users only)

The component does not authenticate anyone: the `userId` you pass is trusted. So public functions take no `userId` argument. They read it from `ctx.auth` and only ever act on that user.

```ts
// convex/push.ts
import { vWebPushSubscription, WebPush } from "@operatornest/convex-web-push";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

export const webPush = new WebPush(components.webPush);

async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not signed in");
  return identity.subject;
}

export const publicKey = query({
  args: {},
  returns: v.union(v.string(), v.null()), // null until VAPID_PUBLIC_KEY is configured
  handler: (ctx) => webPush.getPublicKey(ctx),
});

export const saveSubscription = mutation({
  args: { subscription: vWebPushSubscription, userAgent: v.optional(v.string()) },
  returns: v.object({ subscriptionId: v.string(), created: v.boolean() }),
  handler: async (ctx, args) =>
    webPush.recordSubscription(ctx, { userId: await requireUserId(ctx), ...args }),
});

export const removeSubscription = mutation({
  args: { endpoint: v.string() },
  returns: v.boolean(),
  // Passing userId stops a leaked endpoint from removing someone else's subscription.
  handler: async (ctx, { endpoint }) =>
    webPush.removeSubscription(ctx, { endpoint, userId: await requireUserId(ctx) }),
});
```

### 2. Subscribe in the browser

Call `subscribe` from a user gesture (a button click), never on page load. The worker's scope must cover the page; `subscribe` waits up to 10 seconds for it to activate and then fails with a scope hint.

```ts
import { isSupported, subscribe } from "@operatornest/convex-web-push/browser";

async function enableNotifications() {
  if (!isSupported()) return; // see "iOS and Safari" below
  const vapidPublicKey = await convex.query(api.push.publicKey);
  if (!vapidPublicKey) throw new Error("Push is not configured on this deployment");
  const subscription = await subscribe({ vapidPublicKey, serviceWorkerPath: "/sw.js" });
  await convex.mutation(api.push.saveSubscription, {
    subscription,
    userAgent: navigator.userAgent,
  });
}
```

`/browser` also exports `permissionState()`, `getSubscription()` and `unsubscribe()`. Browser failures throw Web Push errors (`WEB_PUSH_UNSUPPORTED`, `WEB_PUSH_PERMISSION_DENIED`, `WEB_PUSH_SERVICE_WORKER_FAILED`). Re-sync on each app load by comparing `getSubscription()` with your server state. When you rotate the VAPID key, `subscribe` replaces subscriptions made with the old key.

### 3. Add a service worker

Serve it from your own origin. Either copy `node_modules/@operatornest/convex-web-push/sw/convex-web-push-sw.js` to your site root (for example `public/sw.js`), or bundle the handlers:

```ts
// sw.ts
import { registerPushHandlers } from "@operatornest/convex-web-push/sw";

registerPushHandlers(self, { defaultIcon: "/icon-192.png", defaultUrl: "/" });
```

Both handle the payload from `sendNotification` and always call `showNotification` (browsers require a visible notification). Clicking focuses a window on the target URL or opens one; only same-origin `url` values are followed.

### 4. Send

Sending to a user is a server-side decision, so these functions are **internal**: a browser cannot call them with someone else's `userId`. Expose to clients only what the app has authorized, for example "notify me".

```ts
export const onNotificationComplete = internalMutation({
  args: vNotificationResult,
  returns: v.null(),
  handler: async (ctx, { notificationId, status, counts }) => {
    // Record the outcome, update your UI state, and so on.
    return null;
  },
});

// Server-side only: called from other functions, crons or webhooks, never from a browser.
export const notifyOrderShipped = internalMutation({
  args: { userId: v.string(), orderId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, { userId, orderId }): Promise<string | null> =>
    webPush.sendNotification(ctx, {
      userId,
      notification: {
        title: "Your order shipped",
        body: `Order ${orderId} is on its way`,
        url: `/orders/${orderId}`,
        tag: `order-${orderId}`,
        data: { orderId },
      },
      options: {
        ttl: 3600,
        urgency: "normal",
        idempotencyKey: `shipped-${orderId}`,
        onComplete: internal.push.onNotificationComplete,
      },
    }),
});

// A signed-in user may notify only themselves.
export const notifyMe = mutation({
  args: { title: v.string(), body: v.optional(v.string()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, notification): Promise<string | null> =>
    webPush.sendNotification(ctx, { userId: await requireUserId(ctx), notification }),
});
```

`sendNotification` returns the notification id, or `null` when the user has no active subscription. `onComplete` must be an **internal** mutation of yours, typed to `NotificationResult`; it is called once when every delivery has finished, and a failing callback does not undo delivery counts. The idempotency key of a send that failed for good (every delivery failed) is released, so a retry with the same key sends again.

Broadcasts are internal-only, and the audience is whatever your own code selected. `sendNotificationBatch` takes at most 100 user ids per call. For a larger audience call it from an internal action, once per slice of 100:

```ts
export const sendSlice = internalMutation({
  args: { userIds: v.array(v.string()), title: v.string() },
  returns: v.null(),
  handler: async (ctx, { userIds, title }) => {
    await webPush.sendNotificationBatch(ctx, { userIds, notification: { title } });
    return null;
  },
});

export const broadcast = internalAction({
  args: { userIds: v.array(v.string()), title: v.string() },
  returns: v.null(),
  handler: async (ctx, { userIds, title }) => {
    for (let i = 0; i < userIds.length; i += 100) {
      await ctx.runMutation(internal.push.sendSlice, {
        userIds: userIds.slice(i, i + 100),
        title,
      });
    }
    return null;
  },
});
```

Each `sendSlice` call is one bounded transaction. A batch transaction writes at most 150 deliveries and never starts a user whose subscriptions would not fit in what is left (a user has at most 50, so the first user always fits): that user and the rest continue in a scheduled transaction. For example 49, 50, 50 and 50 subscriptions run as 149 deliveries now and 50 in the continuation. Test mode is decided once when the batch is created and applies to the whole batch.

### 5. Run the self-test after deploying

```ts
export const selfTest = internalAction({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    testMode: v.boolean(),
    config: v.object({ configured: v.boolean(), problem: v.optional(v.string()) }),
    checks: v.array(v.object({ name: v.string(), ok: v.boolean(), error: v.optional(v.string()) })),
  }),
  handler: (ctx) => webPush.selfTest(ctx),
});
```

```sh
npx convex run push:selfTest
```

It checks SHA-256, ECDH P-256, the RFC 8291 Appendix A vector, VAPID sign and verify, and that your configured key pair matches. It never returns key material.

## API reference

`new WebPush(components.webPush, { testMode?, allowedPushHosts? })`. Every method takes `(ctx, args)`.

| Method                                                            | Context  | Description                                                                                                                                                                                         |
| ----------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordSubscription(ctx, { userId, subscription, userAgent? })`   | mutation | Upserts by endpoint; an endpoint that moves to another user is reassigned. Returns `{ subscriptionId, created }`.                                                                                   |
| `removeSubscription(ctx, { endpoint, userId? })`                  | mutation | Deletes one subscription and returns whether it existed. The endpoint is a capability URL; pass `userId` to remove it only if it belongs to that user.                                              |
| `removeAllForUser(ctx, { userId })`                               | mutation | Deletes one bounded batch (100) of the user's subscriptions. Returns `{ removed, done }`: `removed` counts this batch, and when `done` is false scheduled batches delete the rest.                  |
| `sendNotification(ctx, { userId, notification, options? })`       | mutation | Structured notification to every active subscription. Returns the id or `null`.                                                                                                                     |
| `sendNotificationBatch(ctx, { userIds, notification, options? })` | mutation | Up to 100 users in one bounded transaction. Returns `{ batchId, results, done }`; when `done` is false the rest continues in scheduled mutations. Over 100 users throws `WEB_PUSH_BATCH_TOO_LARGE`. |
| `sendRaw(ctx, { userId, payload, options? })`                     | mutation | Your own payload (`string` or `Uint8Array`) for a custom service worker.                                                                                                                            |
| `getNotification(ctx, { notificationId })`                        | query    | Notification with status and counts, or `null`.                                                                                                                                                     |
| `getBatch(ctx, { batchId })`                                      | query    | `{ status, total, processed, notificationIds }` or `null`.                                                                                                                                          |
| `getDeliveries(ctx, { notificationId })`                          | query    | Per-subscription delivery rows (up to 100).                                                                                                                                                         |
| `getNotificationsForUser(ctx, { userId, paginationOpts })`        | query    | Paginated history, newest first.                                                                                                                                                                    |
| `getStatusForUser(ctx, { userId })`                               | query    | `{ subscriptions, paused, lastSuccessAt? }`. Reads at most 50 of each state.                                                                                                                        |
| `pauseNotifications(ctx, { userId })`                             | mutation | Pauses the user's active subscriptions; returns how many.                                                                                                                                           |
| `resumeNotifications(ctx, { userId })`                            | mutation | Resumes the user's paused subscriptions; returns how many.                                                                                                                                          |
| `getPublicKey(ctx)`                                               | query    | The VAPID public key, or `null`.                                                                                                                                                                    |
| `selfTest(ctx)`                                                   | action   | WebCrypto diagnostics.                                                                                                                                                                              |

Also exported: `generateVapidKeys()`, `vWebPushSubscription`, `vNotificationResult`, the types `NotificationResult`, `WebPushSubscription`, `PushNotification`, `SendOptions`, `Urgency`, `WebPushOptions`, `MAX_PLAINTEXT_BYTES`, and the error helpers below.

Send options: `ttl` (seconds, default 86400, clamped to 0 to 2,419,200), `urgency` (`very-low` | `low` | `normal` | `high`), `topic` (1 to 32 characters of `A-Za-z0-9_-`; a newer message with the same topic replaces a pending one), `idempotencyKey` (per user) and `onComplete`.

Notification shape: `{ title, body?, icon?, badge?, image?, url?, tag?, renotify?, requireInteraction?, silent?, timestamp?, actions?, data? }`.

Notification `status` is `queued`, `partial`, `delivered` (every delivery finished, at least one sent) or `failed`. `counts` has `queued`, `sent`, `failed` and `gone`. "Sent" means the push service accepted the message (HTTP 201), not that a device displayed it.

`getNotificationsForUser` uses `paginator` from `convex-helpers`, because components cannot call the built-in `.paginate()`.

## Error codes

Errors are `ConvexError<{ code, message, retryable? }>`. The client exports `WEB_PUSH_ERROR_CODES`, the `WebPushErrorCode` union and `isWebPushError(error)`:

```ts
import { isWebPushError } from "@operatornest/convex-web-push";

try {
  await ctx.runMutation(internal.push.notifyOrderShipped, args);
} catch (error) {
  if (isWebPushError(error) && error.data.code === "WEB_PUSH_NOT_CONFIGURED") {
    // fix the deployment config
  }
  throw error;
}
```

| Code                             | Thrown when                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_PUSH_NOT_CONFIGURED`        | A send without test mode finds VAPID settings missing or invalid, or `WEB_PUSH_MAX_PARALLELISM` is invalid.                                                                                           |
| `WEB_PUSH_INVALID_SUBSCRIPTION`  | The endpoint host is not allowed, or `p256dh` / `auth` are malformed.                                                                                                                                 |
| `WEB_PUSH_INVALID_PAYLOAD`       | The notification is not JSON-serializable (BigInt, circular reference), or a raw payload marked `base64url` is not valid base64url.                                                                   |
| `WEB_PUSH_PAYLOAD_TOO_LARGE`     | The payload exceeds 3993 bytes. Thrown on the client before any call, and again by the component.                                                                                                     |
| `WEB_PUSH_INVALID_TOPIC`         | `topic` is not 1 to 32 characters of `A-Za-z0-9_-`.                                                                                                                                                   |
| `WEB_PUSH_BATCH_TOO_LARGE`       | A batch has more than 100 distinct users.                                                                                                                                                             |
| `WEB_PUSH_INVALID_VAPID_KEY`     | Not thrown to your code from a send. A VAPID key that cannot be parsed or imported shows up in `selfTest` check errors and as the `invalid_vapid_key` or `vapid_not_configured` delivery `errorKind`. |
| `WEB_PUSH_CRYPTO_UNSUPPORTED`    | `generateVapidKeys` runs where WebCrypto cannot export the private scalar. Delivery rows report the same condition as `crypto_error`.                                                                 |
| `WEB_PUSH_UNSUPPORTED`           | `/browser` `subscribe` runs where Web Push is not available.                                                                                                                                          |
| `WEB_PUSH_PERMISSION_DENIED`     | `/browser` `subscribe` and the user did not grant notification permission.                                                                                                                            |
| `WEB_PUSH_SERVICE_WORKER_FAILED` | The service worker has no worker, did not activate in time, or became redundant.                                                                                                                      |

Push service outcomes are not thrown. They are recorded on delivery rows as `errorKind`, for example `subscription_gone`, `rate_limited`, `server_error`, `bad_request`, `vapid_rejected`, `vapid_key_mismatch`, `ttl_expired`, `max_attempts` and `endpoint_not_allowed`.

## Testing

Test mode records notifications and deliveries, tagged `testMode: true`, and marks them sent (`statusCode: 0`) without calling any push service. It is **opt-in only**: pass `testMode: true` to the client, or set `WEB_PUSH_TEST_MODE=true`. Missing credentials never turn it on; without opt-in, sends throw `WEB_PUSH_NOT_CONFIGURED`.

With `convex-test`:

```ts
import { register } from "@operatornest/convex-web-push/test";
import { convexTest } from "convex-test";

const t = convexTest(schema, modules);
register(t); // registers the component and its workpool
```

Use `vi.useFakeTimers()` and `await t.finishAllScheduledFunctions(vi.runAllTimers)` to run deliveries, and `vi.stubGlobal("fetch", ...)` to mock push services. Use generated keys, never production ones.

## Data retention

A component cron runs every 6 hours in bounded batches (500 deletes per transaction, rescheduling itself while more remains):

- finished deliveries and notifications and finished batches: deleted after 7 days;
- subscriptions marked gone: deleted after 7 days;
- rows still unfinished: deleted after 35 days.

Other limits: 50 live (active plus paused) subscriptions per user (the oldest is retired), 100 users per batch call, 3993 payload bytes (a 4096-byte push body minus the 86-byte header, 1-byte delimiter and 16-byte tag), TTL at most 4 weeks.

Retry rules: retryable results (`429`, `408`, `5xx`, network errors, timeouts) retry with exponential backoff and jitter, up to 5 attempts, honouring `Retry-After`. A retry that would land at or after the TTL is not scheduled, and `ttl: 0` means one attempt. Each attempt sends the remaining TTL. Permanent results (`400`, `401`, `403`, `413`, other `4xx`) are not retried. A subscription created under a different VAPID public key than the current one is marked gone. Delivery is at-least-once across retries; use `topic` to collapse duplicates on the device.

## Known limitations

What is and is not verified:

- **Tested against the local Convex backend only.** `pnpm smoke` runs the full pipeline there, including ECDH, HKDF, AES-GCM, ECDSA and JWK import, in test mode. We have not run it on Convex Cloud; run `selfTest` after deploying.
- **No real push service is called by any test.** Request headers, encryption and signing are checked against the RFCs and an independent decryptor, not against FCM, Mozilla, Apple or WNS. The classification of responses (`404` and `410` gone, `413` too large, `401` and `403` rejected VAPID, `429` and `5xx` retryable) follows RFC 8030 and common push service behaviour and is untested against live services.
- **Service-specific limits are not confirmed against each vendor.** The 4-week TTL cap is the conservative figure used for every service; Apple's own limits, and how each service treats `Topic` and `Urgency`, are untested here.
- **WNS (`*.notify.windows.com`) endpoints** are on the default allowlist but untested.
- **Subscription changes.** Browsers handle `pushsubscriptionchange` unevenly. Re-run `subscribe` and `recordSubscription` on app load.
- Not included: React hooks, Declarative Web Push, per-subscription pause, scheduled sends, multiple VAPID key sets and built-in rate limiting (wrap `sendNotification` with your own).

iOS and Safari: iOS and iPadOS 16.4 and newer support Web Push only for web apps installed to the Home Screen; in a normal Safari tab `PushManager` is absent and `isSupported()` returns `false`. Request permission from a user gesture inside the installed app. Every push must produce a visible notification, which the bundled worker always does. Safari does not support notification `actions`.

## Security

- VAPID keys live only in component environment variables; they are never arguments, rows, logs or return values.
- **Trust boundary: your app.** The component trusts the `userId`, `userIds` and `endpoint` you pass, because it cannot know who your caller is. A public function that forwards a client-supplied `userId` lets any visitor notify, pause or delete any user. So: derive `userId` from `ctx.auth` in public functions, make anything that names other users (including broadcasts) `internalMutation` or `internalAction`, and authorize the audience in your own code before calling the client. Pass `userId` to `removeSubscription` so a leaked endpoint cannot remove another user's subscription.
- Subscription endpoints are untrusted capability URLs. Only `https` hosts on the allowlist, without credentials, custom ports or IP literals, are accepted when recording and when sending; redirects are not followed.
- Payloads are encrypted end to end with a fresh ephemeral key and salt per message.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Decisions are in [docs/adr/](docs/adr/).

Maintained by OperatorNest · Ravalika Korthiwada ([@ravalikamaker](https://github.com/ravalikamaker))

## License

MIT. See [LICENSE](LICENSE).
