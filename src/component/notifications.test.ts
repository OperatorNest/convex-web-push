import { type WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { base64urlEncode, bytesEqual } from "../shared/base64url.js";
import { isWebPushError } from "../shared/errors.js";
import { verifyVapidJwt } from "../shared/vapid.js";
import { api, internal } from "./_generated/api.js";
import { type Id } from "./_generated/dataModel.js";
import {
  type TestCtx,
  configureVapid,
  decryptAes128gcm,
  drain,
  expectWebPushError,
  makeSubscription,
  requestBody,
  requestHeaders,
  required,
  respond,
  respondInOrder,
  setupLiveTest,
  setupSimulatedTest,
  stubFetch,
} from "../test-helpers.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function subscribe(t: TestCtx, userId = "u1", host?: string) {
  const sub = await makeSubscription(host);
  await t.mutation(api.subscriptions.record, { userId, subscription: sub.subscription });
  return sub;
}

async function subscribeBatch(t: TestCtx, users: string[], counts: number[]) {
  const template = await makeSubscription();
  let endpointNumber = 0;
  for (const [userIndex, userId] of users.entries()) {
    for (let n = 0; n < required(counts[userIndex], "subscription count"); n++) {
      const endpoint = new URL(template.subscription.endpoint);
      endpoint.searchParams.set("subscription", String(endpointNumber++));
      await t.mutation(api.subscriptions.record, {
        userId,
        subscription: { ...template.subscription, endpoint: endpoint.toString() },
      });
    }
  }
}

async function deliveryForUser(t: TestCtx, userId: string) {
  const notification = await t.run((ctx) =>
    ctx.db
      .query("notifications")
      .withIndex("by_userId_and_testMode_and_createdAt", (q) => q.eq("userId", userId))
      .first(),
  );
  if (!notification) return null;
  return t.run((ctx) =>
    ctx.db
      .query("deliveries")
      .withIndex("by_notificationId", (q) => q.eq("notificationId", notification._id))
      .first(),
  );
}

async function finished(t: TestCtx, notificationId: Id<"notifications">) {
  await drain(t);
  const notification = required(
    await t.run((ctx) => ctx.db.get("notifications", notificationId)),
    "the notification row",
  );
  const deliveries = await t.run((ctx) =>
    ctx.db
      .query("deliveries")
      .withIndex("by_notificationId", (q) => q.eq("notificationId", notificationId))
      .take(100),
  );
  return { notification, deliveries };
}

test("test mode records a send without calling fetch", async () => {
  const calls = stubFetch(respond(201));
  const t = setupSimulatedTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: '{"title":"hi"}',
  });
  const { notification, deliveries } = await finished(t, required(id, "the notification id"));
  expect(notification.status).toBe("delivered");
  expect(notification.counts).toEqual({ queued: 0, sent: 1, failed: 0, gone: 0 });
  expect(deliveries[0]).toMatchObject({ status: "sent", attempts: 1 });
  expect(deliveries[0]).not.toHaveProperty("providerStatus");
  expect(calls).toHaveLength(0);
});

test("an explicit testMode wins over configured credentials", async () => {
  await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  const sub = await makeSubscription();
  await t.mutation(api.subscriptions.record, {
    userId: "u1",
    subscription: sub.subscription,
    testMode: true,
  });
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
    testMode: true,
  });
  expect((await finished(t, required(id, "the notification id"))).notification.status).toBe(
    "delivered",
  );
  expect(calls).toHaveLength(0);
});

test("sends an encrypted, signed request with TTL, Urgency and Topic", async () => {
  const keys = await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  const sub = await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    userId: "u1",
    payload: '{"title":"héllo"}',
    ttlSeconds: 3600,
    urgency: "high",
    topic: "unread",
  });
  const { notification, deliveries } = await finished(t, required(id, "the notification id"));
  expect(notification.status).toBe("delivered");
  expect(deliveries[0]).toMatchObject({ status: "sent", providerStatus: 201 });

  expect(calls).toHaveLength(1);
  expect(required(calls[0], "the push request").url).toBe(sub.subscription.endpoint);
  const headers = requestHeaders(calls);
  expect(headers.get("Urgency")).toBe("high");
  expect(headers.get("Topic")).toBe("unread");
  expect(headers.get("Content-Encoding")).toBe("aes128gcm");
  expect(Number(headers.get("TTL"))).toBeGreaterThan(0);
  expect(Number(headers.get("TTL"))).toBeLessThanOrEqual(3600);
  const jwt = /t=([^,]+),/.exec(headers.get("Authorization") ?? "")?.[1] ?? "";
  const verified = await verifyVapidJwt(jwt, keys.publicKey);
  expect(verified?.claims).toMatchObject({
    aud: "https://fcm.googleapis.com",
    sub: "mailto:ops@acme.dev",
  });
  const plaintext = await decryptAes128gcm(
    required(requestBody(calls), "the request body"),
    sub.uaPrivate,
    sub.uaPublic,
    sub.authSecret,
  );
  expect(new TextDecoder().decode(plaintext)).toBe('{"title":"héllo"}');

  const status = await t.query(api.subscriptions.getStatus, { userId: "u1" });
  expect(status.lastSuccessAt).toBeTypeOf("number");
});

test("sendRaw style base64url payloads are sent as the original bytes", async () => {
  await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  const sub = await subscribe(t);
  const bytes = new Uint8Array([0, 255, 128, 7]);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: base64urlEncode(bytes),
    payloadEncoding: "base64url",
  });
  await finished(t, required(id, "the notification id"));
  const plaintext = await decryptAes128gcm(
    required(requestBody(calls), "the request body"),
    sub.uaPrivate,
    sub.uaPublic,
    sub.authSecret,
  );
  expect(bytesEqual(plaintext, bytes)).toBe(true);
});

test("an empty payload is sent as a bodyless push", async () => {
  await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "",
  });
  await finished(t, required(id, "the notification id"));
  expect(requestBody(calls)).toBeNull();
});

test.each([404, 410])("%i marks the subscription gone and is not retried", async (status) => {
  await configureVapid();
  const calls = stubFetch(respond(status));
  const t = setupLiveTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  const { notification, deliveries } = await finished(t, required(id, "the notification id"));
  expect(calls).toHaveLength(1);
  expect(deliveries[0]).toMatchObject({
    status: "gone",
    providerStatus: status,
    errorKind: "subscription_gone",
  });
  expect(notification).toMatchObject({
    status: "failed",
    counts: { queued: 0, sent: 0, failed: 0, gone: 1 },
  });
  const userStatus = await t.query(api.subscriptions.getStatus, { userId: "u1" });
  expect(userStatus.activeCount).toBe(0);
  expect(
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
    }),
  ).toBeNull();
});

test("a permanent error is not retried and records fixed error data", async () => {
  await configureVapid();
  const calls = stubFetch(respond(400));
  const t = setupLiveTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  const { notification, deliveries } = await finished(t, required(id, "the notification id"));
  expect(calls).toHaveLength(1);
  expect(deliveries[0]).toMatchObject({
    status: "failed",
    errorKind: "bad_request",
    error: {
      code: "WEB_PUSH_PROVIDER_ERROR",
      providerStatus: 400,
      message: "The push service rejected the message.",
    },
  });
  expect(notification.counts.failed).toBe(1);
  const sub = await t.run((ctx) => ctx.db.query("subscriptions").first());
  expect(sub).toMatchObject({ status: "active", consecutiveFailures: 1 });
});

test("a server error is retried with backoff until it succeeds", async () => {
  await configureVapid();
  const calls = stubFetch(respondInOrder(respond(503), respond(502), respond(201)));
  const t = setupLiveTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  const { notification, deliveries } = await finished(t, required(id, "the notification id"));
  expect(calls).toHaveLength(3);
  expect(deliveries[0]).toMatchObject({ status: "sent", attempts: 3 });
  expect(notification.status).toBe("delivered");
});

test("network errors are retried", async () => {
  await configureVapid();
  const calls = stubFetch(
    respondInOrder(() => {
      throw new TypeError("connection reset");
    }, respond(201)),
  );
  const t = setupLiveTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  const { deliveries } = await finished(t, required(id, "the notification id"));
  expect(calls).toHaveLength(2);
  expect(deliveries[0]).toMatchObject({ status: "sent", attempts: 2 });
});

test("429 honours Retry-After", async () => {
  await configureVapid();
  const requestedAt: number[] = [];
  const respondNext = respondInOrder(respond(429, { "Retry-After": "600" }), respond(201));
  stubFetch((call, index) => {
    requestedAt.push(Date.now());
    return respondNext(call, index);
  });
  const t = setupLiveTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  const { deliveries } = await finished(t, required(id, "the notification id"));
  expect(deliveries[0]).toMatchObject({ status: "sent", attempts: 2 });
  expect(
    required(requestedAt[1], "the retry") - required(requestedAt[0], "the first request"),
  ).toBeGreaterThanOrEqual(600_000);
});

test("gives up after the maximum number of attempts", async () => {
  await configureVapid();
  const calls = stubFetch(respond(503));
  const t = setupLiveTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    urgency: "normal",
    userId: "u1",
    payload: "x",
    ttlSeconds: 86_400,
  });
  const { notification, deliveries } = await finished(t, required(id, "the notification id"));
  expect(calls).toHaveLength(5);
  expect(deliveries[0]).toMatchObject({
    status: "failed",
    attempts: 5,
    errorKind: "max_attempts",
    providerStatus: 503,
  });
  expect(notification.status).toBe("failed");
});

test("a long Retry-After beyond the TTL is not waited for", async () => {
  await configureVapid();
  const calls = stubFetch(respond(429, { "Retry-After": "7200" }));
  const t = setupLiveTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    urgency: "normal",
    userId: "u1",
    payload: "x",
    ttlSeconds: 3600,
  });
  const { deliveries } = await finished(t, required(id, "the notification id"));
  expect(calls).toHaveLength(1);
  expect(deliveries[0]).toMatchObject({
    status: "failed",
    errorKind: "ttl_expired",
    providerStatus: 429,
  });
});

test("fans out to every active subscription and reports partial results", async () => {
  await configureVapid();
  let n = 0;
  const calls = stubFetch(
    () => new Response(n++ === 0 ? null : "gone", { status: n === 1 ? 201 : 410 }),
  );
  const t = setupLiveTest();
  await subscribe(t);
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  const { notification, deliveries } = await finished(t, required(id, "the notification id"));
  expect(calls).toHaveLength(2);
  expect(deliveries).toHaveLength(2);
  expect(notification).toMatchObject({
    status: "delivered",
    counts: { queued: 0, sent: 1, failed: 0, gone: 1 },
  });
});

test("returns null when the user has no active subscription, paused or otherwise", async () => {
  const t = setupSimulatedTest();
  expect(
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "nobody",
      payload: "x",
    }),
  ).toBeNull();
  await subscribe(t);
  await t.mutation(api.subscriptions.pause, { userId: "u1" });
  expect(
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
    }),
  ).toBeNull();
  await t.mutation(api.subscriptions.resume, { userId: "u1" });
  expect(
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
    }),
  ).not.toBeNull();
});

test("idempotencyKey dedupes per user and sends once", async () => {
  await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  await subscribe(t);
  await subscribe(t, "u2");
  const first = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
    idempotencyKey: "k1",
  });
  const again = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
    idempotencyKey: "k1",
  });
  const other = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u2",
    payload: "x",
    idempotencyKey: "k1",
  });
  expect(again).toBe(first);
  expect(other).not.toBe(first);
  await drain(t);
  expect(calls).toHaveLength(2);
  expect(await t.run((ctx) => ctx.db.query("notifications").take(10000))).toHaveLength(2);
});

test("idempotency keys separate live and test notifications and reject changed arguments", async () => {
  await configureVapid();
  const t = setupLiveTest();
  const { subscription } = await makeSubscription();
  for (const testMode of [false, true]) {
    await t.mutation(api.subscriptions.record, { userId: "alice", subscription, testMode });
  }
  const args = {
    userId: "alice",
    payload: "message",
    ttlSeconds: 60,
    urgency: "normal" as const,
    idempotencyKey: "event",
  };
  const liveId = required(
    await t.mutation(api.notifications.send, { ...args, testMode: false }),
    "the live notification id",
  );
  const testId = required(
    await t.mutation(api.notifications.send, { ...args, testMode: true }),
    "the test notification id",
  );
  expect(testId).not.toBe(liveId);
  expect(await t.mutation(api.notifications.send, { ...args, testMode: true })).toBe(testId);
  await expectWebPushError(
    t.mutation(api.notifications.send, { ...args, ttlSeconds: 61, testMode: true }),
    "WEB_PUSH_IDEMPOTENCY_CONFLICT",
  );
  const history = await t.query(api.notifications.list, {
    userId: "alice",
    testMode: true,
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(history.page.map((row) => row._id)).toEqual([testId]);
  await expectWebPushError(
    t.query(api.notifications.get, {
      userId: "alice",
      notificationId: liveId,
      testMode: true,
    }),
    "WEB_PUSH_NOT_FOUND",
  );
  await expectWebPushError(
    t.query(api.deliveries.list, {
      userId: "alice",
      notificationId: liveId,
      testMode: true,
    }),
    "WEB_PUSH_NOT_FOUND",
  );
});

test("sendBatch fans out per user and dedupes repeated user IDs", async () => {
  const t = setupSimulatedTest();
  await subscribe(t, "a");
  await subscribe(t, "b");
  const { results, done } = await t.mutation(api.notifications.sendBatch, {
    ttlSeconds: 86400,
    urgency: "normal",
    userIds: ["a", "b", "c", "a"],
    payload: "x",
  });
  expect(done).toBe(true);
  expect(results.map((r) => [r.userId, r.notificationId !== null])).toEqual([
    ["a", true],
    ["b", true],
    ["c", false],
  ]);
  await expectWebPushError(
    t.mutation(api.notifications.sendBatch, {
      ttlSeconds: 86400,
      urgency: "normal",
      userIds: Array.from({ length: 101 }, (_, i) => `u${i}`),
      payload: "x",
    }),
    "WEB_PUSH_INVALID_ARGUMENT",
  );
});

test("rejects oversized payloads by UTF-8 byte length, and bad topics", async () => {
  const t = setupSimulatedTest();
  await subscribe(t);
  await expect(
    t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "a".repeat(3993),
    }),
  ).resolves.not.toBeNull();
  await expectWebPushError(
    t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "a".repeat(3994),
    }),
    "WEB_PUSH_PAYLOAD_TOO_LARGE",
  );
  await expectWebPushError(
    t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "é".repeat(2000),
    }),
    "WEB_PUSH_PAYLOAD_TOO_LARGE",
  );
  await expectWebPushError(
    t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
      topic: "bad topic!",
    }),
    "WEB_PUSH_INVALID_ARGUMENT",
  );
  await expectWebPushError(
    t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "***",
      payloadEncoding: "base64url",
    }),
    "WEB_PUSH_INVALID_ARGUMENT",
  );
});

test("unset test mode means live, so sending without VAPID configuration throws and creates nothing", async () => {
  const calls = stubFetch(respond(201));
  const t = setupSimulatedTest();
  await subscribe(t);
  vi.stubEnv("WEB_PUSH_TEST_MODE", undefined);
  await expectWebPushError(
    t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
    }),
    "WEB_PUSH_NOT_CONFIGURED",
  );
  await expectWebPushError(
    t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
      testMode: false,
    }),
    "WEB_PUSH_NOT_CONFIGURED",
  );
  await expectWebPushError(
    t.mutation(api.notifications.sendBatch, {
      ttlSeconds: 86400,
      urgency: "normal",
      userIds: ["u1"],
      payload: "x",
      testMode: false,
    }),
    "WEB_PUSH_NOT_CONFIGURED",
  );
  expect(await t.run((ctx) => ctx.db.query("notifications").take(10000))).toHaveLength(0);
  expect(calls).toHaveLength(0);

  expect(await t.query(api.config.get, { testMode: true })).toEqual({
    applicationServerKey: null,
  });
});

test("invalid VAPID settings throw a configuration error that never echoes key material", async () => {
  const keys = await configureVapid();
  const t = setupLiveTest();
  await subscribe(t);
  vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", "localhost");
  const error = await t
    .mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
    })
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  expect(isWebPushError(error)).toBe(true);
  expect(String(error)).toContain("WEB_PUSH_NOT_CONFIGURED");
  expect(String(error)).toContain("Component configuration is missing");
  expect(String(error)).not.toContain(keys.privateKey);
  vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", "mailto:ops@acme.dev");
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", "not-a-key!");
  const bad = await t
    .mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
    })
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  expect(String(bad)).toContain("WEB_PUSH_NOT_CONFIGURED");
  expect(String(bad)).not.toContain("not-a-key");
});

test("test mode opts in through the WEB_PUSH_TEST_MODE env and tags rows", async () => {
  const calls = stubFetch(respond(201));
  const t = setupSimulatedTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  const { notification, deliveries } = await finished(t, required(id, "the notification id"));
  expect(notification).toMatchObject({ status: "delivered", testMode: true });
  expect(deliveries[0]).toMatchObject({ status: "sent", testMode: true });
  expect(calls).toHaveLength(0);
});

test("test mode opts in through the testMode argument without any env", async () => {
  const calls = stubFetch(respond(201));
  const t = setupSimulatedTest();
  await subscribe(t);
  vi.stubEnv("WEB_PUSH_TEST_MODE", undefined);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
    testMode: true,
  });
  const { notification, deliveries } = await finished(t, required(id, "the notification id"));
  expect(notification.testMode).toBe(true);
  expect(deliveries[0]?.testMode).toBe(true);
  expect(calls).toHaveLength(0);
});

test("real sends are not tagged as test mode", async () => {
  await configureVapid();
  stubFetch(respond(201));
  const t = setupLiveTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  const { notification, deliveries } = await finished(t, required(id, "the notification id"));
  expect(notification.testMode).toBe(false);
  expect(deliveries[0]?.testMode).toBe(false);
});

test("a rotated VAPID key marks old subscriptions gone instead of retrying forever", async () => {
  await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  await subscribe(t);
  await configureVapid();
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  const { deliveries } = await finished(t, required(id, "the notification id"));
  expect(deliveries[0]).toMatchObject({ status: "gone", errorKind: "vapid_key_mismatch" });
  expect(calls).toHaveLength(0);
});

test("the delivery-time SSRF guard applies even if a subscription slipped in earlier", async () => {
  await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  const sub = await makeSubscription("push.example.test");
  await t.mutation(api.subscriptions.record, {
    userId: "u1",
    subscription: sub.subscription,
    allowedPushHosts: ["push.example.test"],
  });
  const blocked = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  expect(
    (await finished(t, required(blocked, "the blocked notification id"))).deliveries[0],
  ).toMatchObject({
    status: "failed",
    errorKind: "endpoint_not_allowed",
  });
  expect(calls).toHaveLength(0);

  const allowed = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
    allowedPushHosts: ["push.example.test"],
  });
  expect(
    (await finished(t, required(allowed, "the allowed notification id"))).deliveries[0],
  ).toMatchObject({
    status: "sent",
  });
  expect(calls).toHaveLength(1);
});

test("subscriptions past their expirationTime are pruned instead of sent to", async () => {
  const t = setupSimulatedTest();
  const sub = await makeSubscription();
  await t.mutation(api.subscriptions.record, {
    userId: "u1",
    subscription: { ...sub.subscription, expirationTime: Date.now() + 1000 },
  });
  vi.setSystemTime(Date.now() + 5000);
  expect(
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
    }),
  ).toBeNull();
  const row = await t.run((ctx) => ctx.db.query("subscriptions").first());
  expect(row?.status).toBe("gone");
});

test("a subscription removed mid-flight ends the delivery without error", async () => {
  await configureVapid();
  stubFetch(respond(201));
  const t = setupLiveTest();
  const sub = await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  await t.mutation(api.subscriptions.remove, { endpoint: sub.subscription.endpoint, userId: "u1" });
  const { notification, deliveries } = await finished(t, required(id, "the notification id"));
  expect(deliveries[0]).toMatchObject({ status: "gone", errorKind: "subscription_removed" });
  expect(notification.counts.gone).toBe(1);
});

test("notification history is paginated newest first", async () => {
  const t = setupSimulatedTest();
  await subscribe(t);
  for (const n of [1, 2, 3]) {
    vi.setSystemTime(Date.now() + 1000);
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: String(n),
    });
  }
  const first = await t.query(api.notifications.list, {
    userId: "u1",
    paginationOpts: { numItems: 2, cursor: null },
  });
  expect(first.page.map((n) => n.payload)).toEqual(["3", "2"]);
  expect(first.isDone).toBe(false);
  const second = await t.query(api.notifications.list, {
    userId: "u1",
    paginationOpts: { numItems: 2, cursor: first.continueCursor },
  });
  expect(second.page.map((n) => n.payload)).toEqual(["1"]);
});

test("a subscription reassigned before delivery never receives the old user's payload", async () => {
  await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  const alice = await subscribe(t, "alice");
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "alice",
    payload: "secret",
  });
  await t.mutation(api.subscriptions.record, { userId: "bob", subscription: alice.subscription });
  await drain(t);
  expect(calls).toHaveLength(0);
  const deliveries = await t.query(api.deliveries.list, {
    notificationId: required(id, "the notification id"),
    userId: "alice",
  });
  expect(deliveries[0]).toMatchObject({ status: "failed", errorKind: "reassigned" });
  const row = await t.run((ctx) => ctx.db.query("subscriptions").first());
  expect(row).toMatchObject({ userId: "bob", status: "active", consecutiveFailures: 0 });
  expect(row?.lastFailureAt).toBeUndefined();
});

test("a large batch continues in scheduled mutations within a delivery budget", async () => {
  const t = setupSimulatedTest();
  const users = ["u1", "u2", "u3", "u4"];
  await subscribeBatch(t, users, [50, 50, 50, 1]);
  const first = await t.mutation(api.notifications.sendBatch, {
    ttlSeconds: 86400,
    urgency: "normal",
    userIds: users,
    payload: "x",
  });
  expect(first.done).toBe(false);
  expect(first.results).toHaveLength(3);
  expect(
    await t.query(api.notifications.getBatch, { batchId: first.batchId, testMode: true }),
  ).toMatchObject({
    status: "running",
    total: 4,
    processed: 3,
  });
  await drain(t);
  const batch = await t.query(api.notifications.getBatch, {
    batchId: first.batchId,
    testMode: true,
  });
  expect(batch).toMatchObject({ status: "done", processed: 4 });
  expect(batch?.notificationIds).toHaveLength(4);
  const rows = await t.run((ctx) => ctx.db.query("notifications").take(10000));
  expect(
    rows.every((n) => n.status === "delivered" && n.counts.sent === (n.userId === "u4" ? 1 : 50)),
  ).toBe(true);
});

test("the remaining TTL is sent on every attempt", async () => {
  await configureVapid();
  const calls = stubFetch(respondInOrder(respond(503), respond(201)));
  const t = setupLiveTest();
  await subscribe(t, "u1");
  const id = await t.mutation(api.notifications.send, {
    urgency: "normal",
    userId: "u1",
    payload: "x",
    ttlSeconds: 100_000,
  });
  const { notification } = await finished(t, required(id, "the notification id"));
  expect(calls).toHaveLength(2);
  const first = Number(requestHeaders(calls, 0).get("TTL"));
  const second = Number(requestHeaders(calls, 1).get("TTL"));
  expect(first).toBeLessThanOrEqual(100_000);
  expect(second).toBeLessThan(first);
  expect(second).toBeGreaterThan(0);
  expect(notification.status).toBe("delivered");
});

test("TTL 0 is sent once with TTL 0 and never retried", async () => {
  await configureVapid();
  const calls = stubFetch(respond(503));
  const t = setupLiveTest();
  await subscribe(t, "u1");
  const id = await t.mutation(api.notifications.send, {
    urgency: "normal",
    userId: "u1",
    payload: "x",
    ttlSeconds: 0,
  });
  const { deliveries } = await finished(t, required(id, "the notification id"));
  expect(calls.map((_, n) => requestHeaders(calls, n).get("TTL"))).toEqual(["0"]);
  expect(deliveries[0]).toMatchObject({ status: "failed", errorKind: "ttl_expired", attempts: 1 });
});

test("a message already expired before its first attempt is not sent", async () => {
  await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  await subscribe(t, "u1");
  const id = await t.mutation(api.notifications.send, {
    urgency: "normal",
    userId: "u1",
    payload: "x",
    ttlSeconds: 60,
  });
  vi.setSystemTime(Date.now() + 120_000);
  const { deliveries } = await finished(t, required(id, "the notification id"));
  expect(calls).toHaveLength(0);
  expect(deliveries[0]).toMatchObject({ status: "failed", errorKind: "ttl_expired" });
});

test("a Retry-After longer than a day is honoured when the TTL allows it", async () => {
  await configureVapid();
  const requestedAt: number[] = [];
  const respondNext = respondInOrder(respond(429, { "Retry-After": "172800" }), respond(201));
  stubFetch((call, index) => {
    requestedAt.push(Date.now());
    return respondNext(call, index);
  });
  const t = setupLiveTest();
  await subscribe(t, "u1");
  await t.mutation(api.notifications.send, {
    urgency: "normal",
    userId: "u1",
    payload: "x",
    ttlSeconds: 2_000_000,
  });
  await drain(t);
  expect(requestedAt).toHaveLength(2);
  expect(
    required(requestedAt[1], "the retry") - required(requestedAt[0], "the first request"),
  ).toBeGreaterThanOrEqual(172_800_000);
});

test("begin computes the remaining TTL in whole seconds", async () => {
  const t = setupSimulatedTest();
  await subscribe(t, "u1");
  const id = await t.mutation(api.notifications.send, {
    urgency: "normal",
    userId: "u1",
    payload: "x",
    ttlSeconds: 600,
  });
  const [delivery] = await t.query(api.deliveries.list, {
    notificationId: required(id, "the notification id"),
    userId: "u1",
  });
  vi.setSystemTime(Date.now() + 100_500);
  const job = await t.mutation(internal.deliveries.begin, {
    deliveryId: required(delivery, "the delivery")._id,
  });
  expect(job).toMatchObject({ ok: true, ttlSeconds: 499 });
});

test("an invalid WEB_PUSH_MAX_PARALLELISM is a configuration error, even in test mode", async () => {
  const t = setupSimulatedTest();
  await subscribe(t);
  vi.stubEnv("WEB_PUSH_MAX_PARALLELISM", "0");
  await expectWebPushError(
    t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
    }),
    "WEB_PUSH_NOT_CONFIGURED",
  );
  vi.stubEnv("WEB_PUSH_MAX_PARALLELISM", "3");
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  expect((await finished(t, required(id, "the notification id"))).notification.status).toBe(
    "delivered",
  );
});

test("malformed parallelism after enqueueing prevents a push request", async () => {
  await configureVapid();
  stubFetch(respondInOrder(respond(503), respond(201)));
  const t = setupLiveTest();
  await subscribe(t);
  vi.stubEnv("WEB_PUSH_MAX_PARALLELISM", "5");
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  vi.stubEnv("WEB_PUSH_MAX_PARALLELISM", "nope");
  const { deliveries } = await finished(t, required(id, "the notification id"));
  expect(deliveries[0]).toMatchObject({
    status: "failed",
    attempts: 1,
    error: { code: "WEB_PUSH_NOT_CONFIGURED" },
  });
});

test.each([
  ["paused", "subscription_paused", "failed"],
  ["gone", "subscription_gone", "gone"],
] as const)(
  "a subscription that is %s by delivery time is not sent to",
  async (state, kind, status) => {
    await configureVapid();
    const calls = stubFetch(respond(201));
    const t = setupLiveTest();
    await subscribe(t);
    const id = await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
    });
    await t.run(async (ctx) => {
      const row = required(await ctx.db.query("subscriptions").first(), "a subscription row");
      await ctx.db.patch("subscriptions", row._id, { status: state });
    });
    const { deliveries } = await finished(t, required(id, "the notification id"));
    expect(calls).toHaveLength(0);
    expect(deliveries[0]).toMatchObject({ status, errorKind: kind });
  },
);

test("a subscription that expires before delivery is marked gone", async () => {
  await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  const sub = await makeSubscription();
  await t.mutation(api.subscriptions.record, {
    userId: "u1",
    subscription: { ...sub.subscription, expirationTime: Date.now() + 60_000 },
  });
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  vi.setSystemTime(Date.now() + 120_000);
  const { deliveries } = await finished(t, required(id, "the notification id"));
  expect(calls).toHaveLength(0);
  expect(deliveries[0]).toMatchObject({ status: "gone", errorKind: "subscription_expired" });
});

test("a delivery whose notification was deleted ends without sending", async () => {
  const t = setupSimulatedTest();
  await subscribe(t);
  const id = required(
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
    }),
    "the notification id",
  );
  await t.run((ctx) => ctx.db.delete("notifications", id));
  await drain(t);
  const rows = await t.run((ctx) => ctx.db.query("deliveries").take(10000));
  expect(rows[0]).toMatchObject({ status: "failed", errorKind: "notification_missing" });
});

test("begin skips a delivery that already finished", async () => {
  const t = setupSimulatedTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  const { deliveries } = await finished(t, required(id, "the notification id"));
  const job = await t.mutation(internal.deliveries.begin, {
    deliveryId: required(deliveries[0], "the delivery")._id,
  });
  expect(job).toMatchObject({ ok: false, outcome: { errorKind: "delivery_closed" } });
});

const workId = "work" as WorkId;

type WorkResult =
  | { kind: "success"; returnValue: unknown }
  | { kind: "failed"; error: string }
  | { kind: "canceled" };

async function queuedDelivery(t: TestCtx) {
  await subscribe(t);
  const id = required(
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
    }),
    "the notification id",
  );
  const rows = await t.run((ctx) => ctx.db.query("deliveries").take(10000));
  return { id, deliveryId: required(rows[0], "the delivery")._id };
}

test("a failed workpool result is retried, a canceled one is not, a garbled one is retried", async () => {
  const t = setupSimulatedTest();
  const { id, deliveryId } = await queuedDelivery(t);
  const complete = (result: WorkResult) =>
    t.mutation(internal.deliveries.onComplete, {
      workId,
      context: { deliveryId },
      result,
    });
  await complete({ kind: "failed", error: "boom" });
  const retried = await t.run((ctx) => ctx.db.get("deliveries", deliveryId));
  expect(retried).toMatchObject({
    status: "retry",
    errorKind: "action_failed",
    attempts: 1,
    error: { retryable: false },
  });

  await complete({ kind: "success", returnValue: "not an outcome" });
  expect(await t.run((ctx) => ctx.db.get("deliveries", deliveryId))).toMatchObject({
    status: "retry",
    errorKind: "invalid_result",
    attempts: 2,
    error: { retryable: false },
  });

  await complete({ kind: "canceled" });
  const { notification, deliveries } = await finished(t, id);
  expect(deliveries[0]).toMatchObject({ status: "failed", errorKind: "canceled", attempts: 3 });
  expect(notification.status).toBe("failed");
});

test("a delivery finished twice is only counted once", async () => {
  const t = setupSimulatedTest();
  const { id, deliveryId } = await queuedDelivery(t);
  const done = {
    workId,
    context: { deliveryId },
    result: {
      kind: "success",
      returnValue: { kind: "sent", providerStatus: 201, attempted: true },
    },
  } as const;
  await t.mutation(internal.deliveries.onComplete, done);
  await t.mutation(internal.deliveries.onComplete, done);
  const notification = await t.query(api.notifications.get, { notificationId: id, userId: "u1" });
  expect(notification?.counts).toEqual({ queued: 0, sent: 1, failed: 0, gone: 0 });
});

test("VAPID settings that disappear after queueing fail the delivery without sending", async () => {
  await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", undefined);
  const { deliveries } = await finished(t, required(id, "the notification id"));
  expect(calls).toHaveLength(0);
  expect(deliveries[0]).toMatchObject({
    status: "failed",
    errorKind: "vapid_not_configured",
    error: {
      code: "WEB_PUSH_NOT_CONFIGURED",
      message: "Component configuration is missing, malformed or changed during a batch.",
    },
  });
});

test("a malformed public key after queueing fails without sending or exposing keys", async () => {
  const keys = await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
  });

  const offCurve = base64urlEncode(new Uint8Array([4, ...new Uint8Array(64).fill(1)]));
  vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", offCurve);
  const { deliveries } = await finished(t, required(id, "the notification id"));
  expect(calls).toHaveLength(0);
  expect(deliveries[0]).toMatchObject({
    status: "failed",
    errorKind: "vapid_not_configured",
    error: { code: "WEB_PUSH_NOT_CONFIGURED" },
  });
  expect(JSON.stringify(deliveries)).not.toContain(keys.privateKey);
});

test("a batch never puts more than 150 deliveries in one transaction", async () => {
  const t = setupSimulatedTest();
  const counts = [49, 50, 50, 2];
  const users = counts.map((_, i) => `cap${i}`);
  await subscribeBatch(t, users, counts);
  const first = await t.mutation(api.notifications.sendBatch, {
    ttlSeconds: 86400,
    urgency: "normal",
    userIds: users,
    payload: "x",
  });

  expect(first.results.map((r) => r.userId)).toEqual(users.slice(0, 3));
  expect(first.done).toBe(false);
  expect(await t.run((ctx) => ctx.db.query("deliveries").take(10000))).toHaveLength(149);

  await t.mutation(internal.notifications.continueBatch, { batchId: first.batchId });
  expect(await t.run((ctx) => ctx.db.query("deliveries").take(10000))).toHaveLength(151);
  const batch = await t.query(api.notifications.getBatch, {
    batchId: first.batchId,
    testMode: true,
  });
  expect(batch).toMatchObject({ status: "done", processed: 4 });
});

test("a batch that exactly fills the budget finishes in one call", async () => {
  const t = setupSimulatedTest();
  const users = ["a", "b", "c"];
  await subscribeBatch(t, users, [50, 50, 50]);
  const first = await t.mutation(api.notifications.sendBatch, {
    ttlSeconds: 86400,
    urgency: "normal",
    userIds: users,
    payload: "x",
  });
  expect(first).toMatchObject({ done: true });
  expect(first.results).toHaveLength(3);
  expect(await t.run((ctx) => ctx.db.query("deliveries").take(10000))).toHaveLength(150);
});

test("a user with the maximum 50 subscriptions always fits an empty budget", async () => {
  const t = setupSimulatedTest();
  await subscribeBatch(t, ["big"], [50]);
  const first = await t.mutation(api.notifications.sendBatch, {
    ttlSeconds: 86400,
    urgency: "normal",
    userIds: ["big"],
    payload: "x",
  });
  expect(first.done).toBe(true);
  expect(first.results[0]?.notificationId).not.toBeNull();
});

test("a failed notification releases its idempotency key so a retry sends", async () => {
  await configureVapid();
  const calls = stubFetch(respondInOrder(respond(410), respond(201)));
  const t = setupLiveTest();
  await subscribe(t);
  const first = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
    idempotencyKey: "order-1",
  });
  const failed = await finished(t, required(first, "the first notification id"));
  expect(failed.notification.status).toBe("failed");
  expect(failed.notification.idempotencyKey).toBeUndefined();

  await subscribe(t);
  const retry = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
    idempotencyKey: "order-1",
  });
  expect(retry).not.toBeNull();
  expect(retry).not.toBe(first);
  expect(
    (await finished(t, required(retry, "the retried notification id"))).notification.status,
  ).toBe("delivered");
  expect(calls).toHaveLength(2);

  const again = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
    idempotencyKey: "order-1",
  });
  expect(again).toBe(retry);
});

const batchAcrossDeliveryBudget = async (t: TestCtx) => {
  const users = ["m0", "m1", "m2", "m3"];
  await subscribeBatch(t, users, [50, 50, 50, 1]);
  return t.mutation(api.notifications.sendBatch, {
    ttlSeconds: 86400,
    urgency: "normal",
    userIds: users,
    payload: "x",
  });
};

test("a test-mode batch stays in test mode when the env changes mid-batch", async () => {
  await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupSimulatedTest();
  const first = await batchAcrossDeliveryBudget(t);
  expect(first.done).toBe(false);
  expect(first.results).toHaveLength(3);
  expect(
    await t.query(api.notifications.getBatch, { batchId: first.batchId, testMode: true }),
  ).toMatchObject({
    status: "running",
    processed: 3,
  });
  vi.stubEnv("WEB_PUSH_TEST_MODE", undefined);

  await t.mutation(internal.notifications.continueBatch, { batchId: first.batchId });
  const initialDelivery = await deliveryForUser(t, "m0");
  const lastDelivery = await deliveryForUser(t, "m3");
  expect(
    await t.action(internal.deliver.run, {
      deliveryId: required(initialDelivery, "the initial delivery")._id,
    }),
  ).toEqual({ kind: "sent" });
  expect(
    await t.action(internal.deliver.run, {
      deliveryId: required(lastDelivery, "the last delivery")._id,
    }),
  ).toEqual({
    kind: "sent",
  });
  expect(calls).toHaveLength(0);
  const rows = await t.run((ctx) => ctx.db.query("notifications").take(10000));
  expect(rows).toHaveLength(4);
  expect(rows.every((n) => n.testMode)).toBe(true);
  const deliveries = await t.run((ctx) => ctx.db.query("deliveries").take(10000));
  expect(deliveries.every((d) => d.testMode)).toBe(true);
  expect(deliveries).toHaveLength(151);
  expect(
    await t.query(api.notifications.getBatch, { batchId: first.batchId, testMode: true }),
  ).toMatchObject({
    status: "done",
    processed: 4,
  });
});

test("a real batch stays real when test mode is switched on mid-batch", async () => {
  await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  const first = await batchAcrossDeliveryBudget(t);
  expect(first.done).toBe(false);
  expect(first.results).toHaveLength(3);
  expect(
    await t.query(api.notifications.getBatch, { batchId: first.batchId, testMode: false }),
  ).toMatchObject({
    status: "running",
    processed: 3,
  });
  vi.stubEnv("WEB_PUSH_TEST_MODE", "true");

  await t.mutation(internal.notifications.continueBatch, { batchId: first.batchId });
  const initialDelivery = await deliveryForUser(t, "m0");
  const lastDelivery = await deliveryForUser(t, "m3");
  expect(
    await t.action(internal.deliver.run, {
      deliveryId: required(initialDelivery, "the initial delivery")._id,
    }),
  ).toEqual({ kind: "sent", providerStatus: 201, attempted: true });
  expect(
    await t.action(internal.deliver.run, {
      deliveryId: required(lastDelivery, "the last delivery")._id,
    }),
  ).toEqual({
    kind: "sent",
    providerStatus: 201,
    attempted: true,
  });
  const rows = await t.run((ctx) => ctx.db.query("notifications").take(10000));
  expect(rows).toHaveLength(4);
  expect(rows.every((n) => !n.testMode)).toBe(true);
  expect(calls).toHaveLength(2);
  const deliveries = await t.run((ctx) => ctx.db.query("deliveries").take(10000));
  expect(deliveries).toHaveLength(151);
  expect(deliveries.every((d) => !d.testMode)).toBe(true);
  await expectWebPushError(
    t.query(api.notifications.getBatch, { batchId: first.batchId, testMode: false }),
    "WEB_PUSH_NOT_FOUND",
  );
  expect(await t.run((ctx) => ctx.db.get("batches", first.batchId))).toMatchObject({
    status: "done",
    nextIndex: 4,
  });
});

test.each(["endpoint", "key", "userId"])("registration bounds %s before storage", async (field) => {
  const t = setupSimulatedTest();
  const { subscription } = await makeSubscription();
  if (field === "endpoint") subscription.endpoint += "a".repeat(10000);
  if (field === "key") subscription.keys.auth += "=".repeat(10000);
  await expectWebPushError(
    t.mutation(api.subscriptions.record, {
      userId: field === "userId" ? "u".repeat(20000) : "u",
      subscription,
    }),
    "WEB_PUSH_INVALID_ARGUMENT",
  );
});

test("batch bounds the supplied array before deduplication", async () => {
  const t = setupSimulatedTest();
  await expectWebPushError(
    t.mutation(api.notifications.sendBatch, {
      ttlSeconds: 86400,
      urgency: "normal",
      userIds: Array(101).fill("u"),
      payload: "x",
    }),
    "WEB_PUSH_INVALID_ARGUMENT",
  );
});

test("raw base64 payload rejects excessive padding before decoding", async () => {
  const t = setupSimulatedTest();
  await expectWebPushError(
    t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u",
      payload: "eA" + "=".repeat(10000),
      payloadEncoding: "base64url",
    }),
    "WEB_PUSH_PAYLOAD_TOO_LARGE",
  );
});

test.each(["not-json", "{}", "123", "[{}]", '["u",0,0,"\\ud800"]'])(
  "history rejects malformed cursor %j with a package error",
  async (cursor) => {
    const t = setupSimulatedTest();
    await expectWebPushError(
      t.query(api.notifications.list, {
        userId: "u",
        paginationOpts: { numItems: 1, cursor },
      }),
      "WEB_PUSH_INVALID_ARGUMENT",
    );
  },
);

test.each([0, 101, 1.5])("history rejects page size %s", async (numItems) => {
  const t = setupSimulatedTest();
  await expectWebPushError(
    t.query(api.notifications.list, {
      userId: "u",
      paginationOpts: { numItems, cursor: null },
    }),
    "WEB_PUSH_INVALID_ARGUMENT",
  );
});

test("endCursor cannot remove the server row budget", async () => {
  const t = setupSimulatedTest();
  const { subscription } = await makeSubscription();
  await t.mutation(api.subscriptions.record, { userId: "u", subscription });
  for (let i = 0; i < 8; i++)
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u",
      payload: "x",
    });
  const last = await t.query(api.notifications.list, {
    userId: "u",
    paginationOpts: { numItems: 8, cursor: null },
  });
  const page = await t.query(api.notifications.list, {
    userId: "u",
    paginationOpts: {
      numItems: 1,
      cursor: null,
      endCursor: last.continueCursor,
      maximumRowsRead: 10000,
    },
  });
  expect(page.page.length).toBeLessThanOrEqual(2);
});

test("expired subscription pruning consumes the batch budget", async () => {
  const t = setupSimulatedTest();
  const { subscription } = await makeSubscription();
  const users = ["a", "b", "c", "d"];
  for (const userId of users)
    for (let i = 0; i < 50; i++)
      await t.mutation(api.subscriptions.record, {
        userId,
        subscription: {
          ...subscription,
          endpoint: subscription.endpoint + userId + i,
          expirationTime: 1,
        },
      });
  const result = await t.mutation(api.notifications.sendBatch, {
    ttlSeconds: 86400,
    urgency: "normal",
    userIds: users,
    payload: "x",
  });
  expect(result.done).toBe(false);
  expect(result.results).toHaveLength(3);
});

test("batch continuation revalidates configuration", async () => {
  await configureVapid();
  const t = setupLiveTest();
  const { subscription } = await makeSubscription();
  const users = ["a", "b", "c", "d"];
  for (const userId of users)
    for (let i = 0; i < 50; i++)
      await t.mutation(api.subscriptions.record, {
        userId,
        subscription: { ...subscription, endpoint: subscription.endpoint + userId + i },
      });
  const result = await t.mutation(api.notifications.sendBatch, {
    ttlSeconds: 86400,
    urgency: "normal",
    userIds: users,
    payload: "x",
  });
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", undefined);
  await t.mutation(internal.notifications.continueBatch, { batchId: result.batchId });
  expect(await t.query(api.notifications.getBatch, { batchId: result.batchId })).toMatchObject({
    status: "failed",
    errorCode: "WEB_PUSH_NOT_CONFIGURED",
  });
});

test("different oversized payloads return the same fixed message", async () => {
  const t = setupSimulatedTest();
  const data = [];
  for (const size of [3994, 3995]) {
    try {
      await t.mutation(api.notifications.send, {
        ttlSeconds: 86400,
        urgency: "normal",
        userId: "u",
        payload: "x".repeat(size),
      });
    } catch (error) {
      if (isWebPushError(error)) data.push(error.data);
      else throw error;
    }
  }
  expect(data).toHaveLength(2);
  expect(data[0]).toEqual(data[1]);
});

test.each(["configuration", "fingerprint"])(
  "batch continuation records terminal failure after %s changes",
  async (change) => {
    await configureVapid();
    const t = setupLiveTest();
    const batchId = await t.run((ctx) =>
      ctx.db.insert("batches", {
        testMode: false,
        userIds: ["alice"],
        vapidPublicKeyHash: "none",
        nextIndex: 0,
        notificationIds: [],
        send: { ttlSeconds: 86400, urgency: "normal", payload: "x", testMode: false },
        status: "running",
        createdAt: Date.now(),
      }),
    );
    if (change === "configuration") vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", undefined);
    await t.mutation(internal.notifications.continueBatch, { batchId });
    expect(await t.query(api.notifications.getBatch, { batchId })).toMatchObject({
      status: "failed",
      errorCode: "WEB_PUSH_NOT_CONFIGURED",
      processed: 0,
    });
    await t.mutation(internal.notifications.continueBatch, { batchId });
    expect(await t.query(api.notifications.getBatch, { batchId })).toMatchObject({
      status: "failed",
      processed: 0,
    });
  },
);

test("notification and delivery reads reject another owner", async () => {
  const t = setupSimulatedTest();
  const { subscription } = await makeSubscription();
  await t.mutation(api.subscriptions.record, { userId: "alice", subscription });
  const notificationId = required(
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "alice",
      payload: "private",
    }),
    "the notification id",
  );
  await expectWebPushError(
    t.query(api.notifications.get, { notificationId, userId: "bob" }),
    "WEB_PUSH_NOT_FOUND",
  );
  await expectWebPushError(
    t.query(api.deliveries.list, { notificationId, userId: "bob" }),
    "WEB_PUSH_NOT_FOUND",
  );
  expect(await t.query(api.notifications.get, { notificationId, userId: "alice" })).toMatchObject({
    payload: "private",
  });
  expect(await t.query(api.deliveries.list, { notificationId, userId: "alice" })).toHaveLength(1);
});

test.each(["subscription_paused", "ttl_expired", "subscription_expired"])(
  "unsent %s preserves subscription failure health",
  async (reason) => {
    const t = setupSimulatedTest();
    const { subscription } = await makeSubscription();
    const saved = await t.mutation(api.subscriptions.record, { userId: "alice", subscription });
    const notificationId = required(
      await t.mutation(api.notifications.send, {
        urgency: "normal",
        userId: "alice",
        payload: "x",
        ttlSeconds: 60,
      }),
      "the notification id",
    );
    const delivery = required(
      await t.run((ctx) =>
        ctx.db
          .query("deliveries")
          .withIndex("by_notificationId", (q) => q.eq("notificationId", notificationId))
          .first(),
      ),
      "the delivery",
    );
    await t.run(async (ctx) => {
      await ctx.db.patch("subscriptions", saved.subscriptionId, {
        consecutiveFailures: 2,
        lastFailureAt: 1,
        ...(reason === "subscription_paused" && { status: "paused" as const }),
        ...(reason === "subscription_expired" && { expirationTime: 1 }),
      });
      if (reason === "ttl_expired")
        await ctx.db.patch("notifications", notificationId, { createdAt: Date.now() - 61000 });
    });
    const outcome = await t.action(internal.deliver.run, { deliveryId: delivery._id });
    expect(outcome.errorKind).toBe(reason);
    await t.mutation(internal.deliveries.onComplete, {
      workId: "work" as never,
      context: { deliveryId: delivery._id },
      result: { kind: "success", returnValue: outcome },
    });
    expect(await t.run((ctx) => ctx.db.get("subscriptions", saved.subscriptionId))).toMatchObject({
      consecutiveFailures: 2,
      lastFailureAt: 1,
    });
    expect(await t.run((ctx) => ctx.db.get("notifications", notificationId))).toMatchObject({
      counts: { queued: 0 },
      status: "failed",
    });
  },
);

test.each([-1, 1.5, 3e6])(
  "TTL %d is rejected before any row is read, even for a user without subscriptions",
  async (ttlSeconds) => {
    const t = setupSimulatedTest();
    await expectWebPushError(
      t.mutation(api.notifications.send, {
        ttlSeconds,
        urgency: "normal",
        userId: "nobody",
        payload: "x",
      }),
      "WEB_PUSH_INVALID_ARGUMENT",
    );
    await expectWebPushError(
      t.mutation(api.notifications.sendBatch, {
        ttlSeconds,
        urgency: "normal",
        userIds: ["nobody"],
        payload: "x",
      }),
      "WEB_PUSH_INVALID_ARGUMENT",
    );
    expect(await t.run((ctx) => ctx.db.query("batches").take(10))).toHaveLength(0);
  },
);

test("a completion callback that is not a function handle is rejected at send", async () => {
  const t = setupSimulatedTest();
  await expectWebPushError(
    t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
      onComplete: "results:onNotificationComplete",
    }),
    "WEB_PUSH_INVALID_ARGUMENT",
  );
});

test("a batch continuation that hits an idempotency conflict fails with progress saved and reports it", async () => {
  const t = setupSimulatedTest();
  const users = ["a", "b", "c", "d"];
  await subscribeBatch(t, users, [50, 50, 50, 1]);
  const first = await t.mutation(api.notifications.sendBatch, {
    ttlSeconds: 86400,
    urgency: "normal",
    userIds: users,
    payload: "digest",
    idempotencyKey: "digest-1",
    onComplete: "function://;results:onBatchComplete",
  });
  expect(first).toMatchObject({ done: false });
  expect(first.results).toHaveLength(3);
  await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "d",
    payload: "other digest",
    idempotencyKey: "digest-1",
  });

  await t.mutation(internal.notifications.continueBatch, { batchId: first.batchId });

  const batch = await t.query(api.notifications.getBatch, { batchId: first.batchId });
  expect(batch).toMatchObject({
    status: "failed",
    errorCode: "WEB_PUSH_IDEMPOTENCY_CONFLICT",
    total: 4,
    processed: 3,
  });
  expect(batch.notificationIds).toHaveLength(3);
  const callbacks = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(1000));
  expect(callbacks.filter((job) => job.name.endsWith("invokeCallback"))).toEqual([
    expect.objectContaining({
      args: [
        {
          handle: "function://;results:onBatchComplete",
          result: {
            batchId: first.batchId,
            testMode: true,
            status: "failed",
            total: 4,
            processed: 3,
            notificationIds: batch.notificationIds,
            errorCode: "WEB_PUSH_IDEMPOTENCY_CONFLICT",
          },
        },
      ],
    }),
  ]);
});

test("a sendBatch whose first step hits an idempotency conflict throws and stores no batch", async () => {
  const t = setupSimulatedTest();
  await subscribe(t, "a");
  await subscribe(t, "b");
  await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "b",
    payload: "earlier digest",
    idempotencyKey: "digest-1",
  });
  await expectWebPushError(
    t.mutation(api.notifications.sendBatch, {
      ttlSeconds: 86400,
      urgency: "normal",
      userIds: ["a", "b"],
      payload: "digest",
      idempotencyKey: "digest-1",
    }),
    "WEB_PUSH_IDEMPOTENCY_CONFLICT",
  );
  expect(await t.run((ctx) => ctx.db.query("batches").take(10))).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.query("notifications").take(10))).toHaveLength(1);
});

test("an idempotency key reused across send and sendBatch compares the notification callback and never the batch callback", async () => {
  const t = setupSimulatedTest();
  await subscribe(t, "a");
  await subscribe(t, "b");
  const fields = { ttlSeconds: 86400, urgency: "normal" as const, payload: "digest" };
  const batch = await t.mutation(api.notifications.sendBatch, {
    ...fields,
    userIds: ["a"],
    idempotencyKey: "digest-1",
    onComplete: "function://;results:onBatchComplete",
  });
  const batchNotificationId = required(
    batch.results[0]?.notificationId,
    "the batch notification id",
  );
  expect(
    await t.mutation(api.notifications.send, {
      ...fields,
      userId: "a",
      idempotencyKey: "digest-1",
    }),
  ).toBe(batchNotificationId);
  const repeated = await t.mutation(api.notifications.sendBatch, {
    ...fields,
    userIds: ["a"],
    idempotencyKey: "digest-1",
    onComplete: "function://;results:onBatchComplete",
  });
  expect(repeated.results).toEqual([{ userId: "a", notificationId: batchNotificationId }]);
  await expectWebPushError(
    t.mutation(api.notifications.send, {
      ...fields,
      userId: "a",
      idempotencyKey: "digest-1",
      onComplete: "function://;results:onNotificationComplete",
    }),
    "WEB_PUSH_IDEMPOTENCY_CONFLICT",
  );
  await t.mutation(api.notifications.send, {
    ...fields,
    userId: "b",
    idempotencyKey: "digest-1",
    onComplete: "function://;results:onNotificationComplete",
  });
  await expectWebPushError(
    t.mutation(api.notifications.sendBatch, {
      ...fields,
      userIds: ["b"],
      idempotencyKey: "digest-1",
      onComplete: "function://;results:onBatchComplete",
    }),
    "WEB_PUSH_IDEMPOTENCY_CONFLICT",
  );
});

test.each(["cursor", "endCursor"] as const)(
  "notification history rejects a six-value %s for its five-value index key",
  async (field) => {
    const t = setupSimulatedTest();
    await expectWebPushError(
      t.query(api.notifications.list, {
        userId: "u",
        paginationOpts: {
          numItems: 1,
          cursor: null,
          [field]: JSON.stringify(["u", true, 0, 0, "id", "extra"]),
        },
      }),
      "WEB_PUSH_INVALID_ARGUMENT",
    );
  },
);

test("notification history accepts a cursor shorter than its index key", async () => {
  const t = setupSimulatedTest();
  const page = await t.query(api.notifications.list, {
    userId: "u",
    paginationOpts: { numItems: 1, cursor: JSON.stringify(["u", true]) },
  });
  expect(page.page).toEqual([]);
});

test("an endpoint restricts fan-out to that subscription of the user", async () => {
  await configureVapid();
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  const target = await subscribe(t);
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId: "u1",
    payload: "x",
    endpoint: target.subscription.endpoint,
  });
  const { notification, deliveries } = await finished(t, required(id, "the notification id"));
  expect(calls.map((call) => call.url)).toEqual([target.subscription.endpoint]);
  expect(deliveries).toHaveLength(1);
  expect(notification).toMatchObject({
    status: "delivered",
    counts: { queued: 0, sent: 1, failed: 0, gone: 0 },
  });
});

test("an endpoint send returns null unless the endpoint is an active subscription of the user", async () => {
  const t = setupSimulatedTest();
  const send = (userId: string, endpoint: string) =>
    t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId,
      payload: "x",
      endpoint,
    });
  const alice = await subscribe(t, "alice");
  await subscribe(t, "bob");
  expect(await send("bob", alice.subscription.endpoint)).toBeNull();
  expect(await send("alice", `${alice.subscription.endpoint}x`)).toBeNull();
  await t.mutation(api.subscriptions.pause, { userId: "alice" });
  expect(await send("alice", alice.subscription.endpoint)).toBeNull();
  await t.mutation(api.subscriptions.resume, { userId: "alice" });
  expect(await send("alice", alice.subscription.endpoint)).not.toBeNull();
  expect(await t.run((ctx) => ctx.db.query("deliveries").take(100))).toHaveLength(1);
  await expectWebPushError(send("alice", ""), "WEB_PUSH_INVALID_ARGUMENT");
});

test("an endpoint send marks that subscription gone when it has expired", async () => {
  const t = setupSimulatedTest();
  const { subscription } = await makeSubscription();
  const saved = await t.mutation(api.subscriptions.record, {
    userId: "u1",
    subscription: { ...subscription, expirationTime: Date.now() + 1000 },
  });
  vi.setSystemTime(Date.now() + 2000);
  expect(
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
      endpoint: subscription.endpoint,
    }),
  ).toBeNull();
  expect(await t.run((ctx) => ctx.db.get("subscriptions", saved.subscriptionId))).toMatchObject({
    status: "gone",
  });
});

test("an idempotency key compares the endpoint", async () => {
  const t = setupSimulatedTest();
  const first = await subscribe(t);
  const second = await subscribe(t);
  const send = (endpoint?: string) =>
    t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "x",
      idempotencyKey: "k1",
      endpoint,
    });
  const id = await send(first.subscription.endpoint);
  expect(await send(first.subscription.endpoint)).toBe(id);
  await expectWebPushError(send(second.subscription.endpoint), "WEB_PUSH_IDEMPOTENCY_CONFLICT");
  await expectWebPushError(send(), "WEB_PUSH_IDEMPOTENCY_CONFLICT");
  const row = required(
    await t.run((ctx) => ctx.db.get("notifications", required(id, "the notification id"))),
    "the notification row",
  );
  expect(row.endpointHash).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(row)).not.toContain(first.subscription.endpoint);
});
