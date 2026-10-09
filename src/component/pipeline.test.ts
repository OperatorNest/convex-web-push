import type { WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { base64urlEncode, bytesEqual } from "../shared/base64url.js";
import { isWebPushError } from "../shared/errors.js";
import { verifyVapidJwt } from "../shared/vapid.js";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  configureVapid,
  decryptAes128gcm,
  drain,
  expectWebPushError,
  makeSubscription,
  required,
  respond,
  setupTest,
  stubFetch,
  type TestCtx,
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
  // Batch boundary tests do not exercise browser key generation. Reuse one valid key pair while
  // assigning each stored subscription a unique endpoint.
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
      .withIndex("by_user_createdAt", (q) => q.eq("userId", userId))
      .first(),
  );
  if (!notification) return null;
  return t.run((ctx) =>
    ctx.db
      .query("deliveries")
      .withIndex("by_notification", (q) => q.eq("notificationId", notification._id))
      .first(),
  );
}

async function finished(t: TestCtx, notificationId: Id<"notifications">) {
  await drain(t);
  const notification = await t.query(api.notifications.get, { notificationId });
  const deliveries = await t.query(api.deliveries.listForNotification, { notificationId });
  return { notification: required(notification, "the notification"), deliveries };
}

test("test mode records a send without calling fetch", async () => {
  const { mock } = stubFetch(respond(201));
  const t = setupTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: '{"title":"hi"}' });
  const { notification, deliveries } = await finished(t, required(id));
  expect(notification.status).toBe("delivered");
  expect(notification.counts).toEqual({ queued: 0, sent: 1, failed: 0, gone: 0 });
  expect(deliveries[0]).toMatchObject({ status: "sent", statusCode: 0, attempts: 1 });
  expect(mock).not.toHaveBeenCalled();
});

test("an explicit testMode wins over configured credentials", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    userId: "u1",
    payload: "x",
    testMode: true,
  });
  expect((await finished(t, required(id))).notification.status).toBe("delivered");
  expect(mock).not.toHaveBeenCalled();
});

test("sends an encrypted, signed request with TTL, Urgency and Topic", async () => {
  const keys = await configureVapid();
  const fetched = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  const sub = await subscribe(t);
  const id = await t.mutation(api.notifications.send, {
    userId: "u1",
    payload: '{"title":"héllo"}',
    ttl: 3600,
    urgency: "high",
    topic: "unread",
  });
  const { notification, deliveries } = await finished(t, required(id));
  expect(notification.status).toBe("delivered");
  expect(deliveries[0]).toMatchObject({ status: "sent", statusCode: 201 });

  expect(fetched.mock).toHaveBeenCalledTimes(1);
  expect(String(required(fetched.calls[0]).url)).toBe(sub.subscription.endpoint);
  const headers = fetched.headers();
  expect(headers.get("Urgency")).toBe("high");
  expect(headers.get("Topic")).toBe("unread");
  expect(headers.get("Content-Encoding")).toBe("aes128gcm");
  expect(Number(headers.get("TTL"))).toBeGreaterThan(0);
  expect(Number(headers.get("TTL"))).toBeLessThanOrEqual(3600);
  const jwt = /t=([^,]+),/.exec(headers.get("Authorization") ?? "")?.[1] ?? "";
  const verified = await verifyVapidJwt(jwt, keys.publicKey);
  expect(verified?.claims).toMatchObject({
    aud: "https://fcm.googleapis.com",
    sub: "mailto:ops@example.com",
  });
  const plaintext = await decryptAes128gcm(
    required(fetched.body()),
    sub.uaPrivate,
    sub.uaPublic,
    sub.authSecret,
  );
  expect(new TextDecoder().decode(plaintext)).toBe('{"title":"héllo"}');

  const status = await t.query(api.subscriptions.statusForUser, { userId: "u1" });
  expect(status.lastSuccessAt).toBeTypeOf("number");
});

test("sendRaw style base64url payloads are sent as the original bytes", async () => {
  await configureVapid();
  const fetched = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  const sub = await subscribe(t);
  const bytes = new Uint8Array([0, 255, 128, 7]);
  const id = await t.mutation(api.notifications.send, {
    userId: "u1",
    payload: base64urlEncode(bytes),
    payloadEncoding: "base64url",
  });
  await finished(t, required(id));
  const plaintext = await decryptAes128gcm(
    required(fetched.body()),
    sub.uaPrivate,
    sub.uaPublic,
    sub.authSecret,
  );
  expect(bytesEqual(plaintext, bytes)).toBe(true);
});

test("an empty payload is sent as a bodyless push", async () => {
  await configureVapid();
  const fetched = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "" });
  await finished(t, required(id));
  expect(fetched.body()).toBeNull();
});

test.each([404, 410])("%i marks the subscription gone and is not retried", async (status) => {
  await configureVapid();
  const { mock } = stubFetch(respond(status));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  const { notification, deliveries } = await finished(t, required(id));
  expect(mock).toHaveBeenCalledTimes(1);
  expect(deliveries[0]).toMatchObject({
    status: "gone",
    statusCode: status,
    errorKind: "subscription_gone",
  });
  expect(notification).toMatchObject({
    status: "failed",
    counts: { queued: 0, sent: 0, failed: 0, gone: 1 },
  });
  const userStatus = await t.query(api.subscriptions.statusForUser, { userId: "u1" });
  expect(userStatus.subscriptions).toBe(0);
  expect(await t.mutation(api.notifications.send, { userId: "u1", payload: "x" })).toBeNull();
});

test("a permanent error is not retried and keeps the response body", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(400));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  const { notification, deliveries } = await finished(t, required(id));
  expect(mock).toHaveBeenCalledTimes(1);
  expect(deliveries[0]).toMatchObject({
    status: "failed",
    errorKind: "bad_request",
    detail: "push service says no",
  });
  expect(notification.counts.failed).toBe(1);
  const sub = await t.run((ctx) => ctx.db.query("subscriptions").first());
  expect(sub).toMatchObject({ status: "active", consecutiveFailures: 1 });
});

test("a server error is retried with backoff until it succeeds", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(503), respond(502), respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  const { notification, deliveries } = await finished(t, required(id));
  expect(mock).toHaveBeenCalledTimes(3);
  expect(deliveries[0]).toMatchObject({ status: "sent", attempts: 3 });
  expect(notification.status).toBe("delivered");
});

test("network errors are retried", async () => {
  await configureVapid();
  const { mock } = stubFetch(() => {
    throw new TypeError("connection reset");
  }, respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  const { deliveries } = await finished(t, required(id));
  expect(mock).toHaveBeenCalledTimes(2);
  expect(deliveries[0]).toMatchObject({ status: "sent", attempts: 2 });
});

test("429 honours Retry-After", async () => {
  await configureVapid();
  const { calls } = stubFetch(respond(429, { "Retry-After": "600" }), respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  const { deliveries } = await finished(t, required(id));
  expect(deliveries[0]).toMatchObject({ status: "sent", attempts: 2 });
  expect(required(calls[1]).time - required(calls[0]).time).toBeGreaterThanOrEqual(600_000);
});

test("gives up after the maximum number of attempts", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(503));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x", ttl: 86_400 });
  const { notification, deliveries } = await finished(t, required(id));
  expect(mock).toHaveBeenCalledTimes(5);
  expect(deliveries[0]).toMatchObject({
    status: "failed",
    attempts: 5,
    errorKind: "max_attempts",
    statusCode: 503,
  });
  expect(notification.status).toBe("failed");
});

test("a TTL of zero is attempted once and never retried", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(503));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const zero = await t.mutation(api.notifications.send, { userId: "u1", payload: "x", ttl: 0 });
  const a = await finished(t, required(zero));
  expect(mock).toHaveBeenCalledTimes(1);
  expect(a.deliveries[0]).toMatchObject({ status: "failed", errorKind: "ttl_expired" });
});

test("a long Retry-After beyond the TTL is not waited for", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(429, { "Retry-After": "7200" }));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x", ttl: 3600 });
  const { deliveries } = await finished(t, required(id));
  expect(mock).toHaveBeenCalledTimes(1);
  expect(deliveries[0]).toMatchObject({
    status: "failed",
    errorKind: "ttl_expired",
    statusCode: 429,
  });
});

test("fans out to every active subscription and reports partial results", async () => {
  await configureVapid();
  let n = 0;
  const { mock } = stubFetch(
    () => new Response(n++ === 0 ? null : "gone", { status: n === 1 ? 201 : 410 }),
  );
  const t = setupTest({ testMode: false });
  await subscribe(t);
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  const { notification, deliveries } = await finished(t, required(id));
  expect(mock).toHaveBeenCalledTimes(2);
  expect(deliveries).toHaveLength(2);
  expect(notification).toMatchObject({
    status: "delivered",
    counts: { queued: 0, sent: 1, failed: 0, gone: 1 },
  });
});

test("returns null when the user has no active subscription, paused or otherwise", async () => {
  const t = setupTest();
  expect(await t.mutation(api.notifications.send, { userId: "nobody", payload: "x" })).toBeNull();
  await subscribe(t);
  await t.mutation(api.subscriptions.pauseForUser, { userId: "u1" });
  expect(await t.mutation(api.notifications.send, { userId: "u1", payload: "x" })).toBeNull();
  await t.mutation(api.subscriptions.resumeForUser, { userId: "u1" });
  expect(await t.mutation(api.notifications.send, { userId: "u1", payload: "x" })).not.toBeNull();
});

test("idempotencyKey dedupes per user and sends once", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  await subscribe(t, "u2");
  const first = await t.mutation(api.notifications.send, {
    userId: "u1",
    payload: "x",
    idempotencyKey: "k1",
  });
  const again = await t.mutation(api.notifications.send, {
    userId: "u1",
    payload: "x",
    idempotencyKey: "k1",
  });
  const other = await t.mutation(api.notifications.send, {
    userId: "u2",
    payload: "x",
    idempotencyKey: "k1",
  });
  expect(again).toBe(first);
  expect(other).not.toBe(first);
  await drain(t);
  expect(mock).toHaveBeenCalledTimes(2);
  expect(await t.run((ctx) => ctx.db.query("notifications").collect())).toHaveLength(2);
});

test("sendBatch fans out per user and dedupes repeated ids", async () => {
  const t = setupTest();
  await subscribe(t, "a");
  await subscribe(t, "b");
  const { results, done } = await t.mutation(api.notifications.sendBatch, {
    userIds: ["a", "b", "c", "a"],
    payload: "x",
  });
  expect(done).toBe(true);
  expect(results.map((r) => [r.userId, r.notificationId !== null])).toEqual([
    ["a", true],
    ["b", true],
    ["c", false],
  ]);
  await expect(
    t.mutation(api.notifications.sendBatch, {
      userIds: Array.from({ length: 101 }, (_, i) => `u${i}`),
      payload: "x",
    }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_BATCH_TOO_LARGE" } });
});

test("rejects oversized payloads by UTF-8 byte length, and bad topics", async () => {
  const t = setupTest();
  await subscribe(t);
  await expect(
    t.mutation(api.notifications.send, { userId: "u1", payload: "a".repeat(3993) }),
  ).resolves.not.toBeNull();
  await expect(
    t.mutation(api.notifications.send, { userId: "u1", payload: "a".repeat(3994) }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_PAYLOAD_TOO_LARGE" } });
  await expect(
    t.mutation(api.notifications.send, { userId: "u1", payload: "é".repeat(2000) }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_PAYLOAD_TOO_LARGE" } });
  await expect(
    t.mutation(api.notifications.send, { userId: "u1", payload: "x", topic: "bad topic!" }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_INVALID_TOPIC" } });
  await expect(
    t.mutation(api.notifications.send, {
      userId: "u1",
      payload: "***",
      payloadEncoding: "base64url",
    }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_INVALID_PAYLOAD" } });
});

test("without opt-in, sending with no VAPID configuration throws and creates nothing", async () => {
  const { mock } = stubFetch(respond(201));
  const t = setupTest();
  await subscribe(t);
  vi.stubEnv("WEB_PUSH_TEST_MODE", undefined);
  await expect(
    t.mutation(api.notifications.send, { userId: "u1", payload: "x" }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_NOT_CONFIGURED" } });
  await expect(
    t.mutation(api.notifications.send, { userId: "u1", payload: "x", testMode: false }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_NOT_CONFIGURED" } });
  await expect(
    t.mutation(api.notifications.sendBatch, { userIds: ["u1"], payload: "x" }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_NOT_CONFIGURED" } });
  expect(await t.run((ctx) => ctx.db.query("notifications").collect())).toHaveLength(0);
  expect(mock).not.toHaveBeenCalled();
  // Recording subscriptions and reading the public key keep working.
  await subscribe(t);
  expect(await t.query(api.config.getPublicKey, {})).toBeNull();
});

test("invalid VAPID settings throw a configuration error that never echoes key material", async () => {
  const keys = await configureVapid("localhost");
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const error = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isWebPushError(error)).toBe(true);
  expect(String(error)).toContain("WEB_PUSH_NOT_CONFIGURED");
  expect(String(error)).toContain("VAPID_SUBJECT");
  expect(String(error)).not.toContain(keys.privateKey);
  vi.stubEnv("VAPID_SUBJECT", "mailto:ops@example.com");
  vi.stubEnv("VAPID_PRIVATE_KEY", "not-a-key!");
  const bad = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(String(bad)).toContain("WEB_PUSH_NOT_CONFIGURED");
  expect(String(bad)).not.toContain("not-a-key");
});

test("test mode opts in through the WEB_PUSH_TEST_MODE env and tags rows", async () => {
  const { mock } = stubFetch(respond(201));
  const t = setupTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  const { notification, deliveries } = await finished(t, required(id));
  expect(notification).toMatchObject({ status: "delivered", testMode: true });
  expect(deliveries[0]).toMatchObject({ status: "sent", statusCode: 0, testMode: true });
  expect(mock).not.toHaveBeenCalled();
});

test("test mode opts in through the testMode argument without any env", async () => {
  const { mock } = stubFetch(respond(201));
  const t = setupTest();
  await subscribe(t);
  vi.stubEnv("WEB_PUSH_TEST_MODE", undefined);
  const id = await t.mutation(api.notifications.send, {
    userId: "u1",
    payload: "x",
    testMode: true,
  });
  const { notification, deliveries } = await finished(t, required(id));
  expect(notification.testMode).toBe(true);
  expect(deliveries[0]?.testMode).toBe(true);
  expect(mock).not.toHaveBeenCalled();
});

test("real sends are not tagged as test mode", async () => {
  await configureVapid();
  stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  const { notification, deliveries } = await finished(t, required(id));
  expect(notification.testMode).toBeUndefined();
  expect(deliveries[0]?.testMode).toBeUndefined();
});

test("a rotated VAPID key marks old subscriptions gone instead of retrying forever", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  await configureVapid();
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  const { deliveries } = await finished(t, required(id));
  expect(deliveries[0]).toMatchObject({ status: "gone", errorKind: "vapid_key_mismatch" });
  expect(mock).not.toHaveBeenCalled();
});

test("the delivery-time SSRF guard applies even if a subscription slipped in earlier", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  const sub = await makeSubscription("push.example.test");
  await t.mutation(api.subscriptions.record, {
    userId: "u1",
    subscription: sub.subscription,
    allowedPushHosts: ["push.example.test"],
  });
  const blocked = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  expect((await finished(t, required(blocked))).deliveries[0]).toMatchObject({
    status: "failed",
    errorKind: "endpoint_not_allowed",
  });
  expect(mock).not.toHaveBeenCalled();

  const allowed = await t.mutation(api.notifications.send, {
    userId: "u1",
    payload: "x",
    allowedPushHosts: ["push.example.test"],
  });
  expect((await finished(t, required(allowed))).deliveries[0]).toMatchObject({ status: "sent" });
  expect(mock).toHaveBeenCalledTimes(1);
});

test("subscriptions past their expirationTime are pruned instead of sent to", async () => {
  const t = setupTest();
  const sub = await makeSubscription();
  await t.mutation(api.subscriptions.record, {
    userId: "u1",
    subscription: { ...sub.subscription, expirationTime: Date.now() + 1000 },
  });
  vi.setSystemTime(Date.now() + 5000);
  expect(await t.mutation(api.notifications.send, { userId: "u1", payload: "x" })).toBeNull();
  const row = await t.run((ctx) => ctx.db.query("subscriptions").first());
  expect(row?.status).toBe("gone");
});

test("a subscription removed mid-flight ends the delivery without error", async () => {
  await configureVapid();
  stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  const sub = await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  await t.mutation(api.subscriptions.remove, { endpoint: sub.subscription.endpoint });
  const { notification, deliveries } = await finished(t, required(id));
  expect(deliveries[0]).toMatchObject({ status: "gone", errorKind: "subscription_removed" });
  expect(notification.counts.gone).toBe(1);
});

test("notification history is paginated newest first", async () => {
  const t = setupTest();
  await subscribe(t);
  for (const n of [1, 2, 3]) {
    vi.setSystemTime(Date.now() + 1000);
    await t.mutation(api.notifications.send, { userId: "u1", payload: String(n) });
  }
  const first = await t.query(api.notifications.listForUser, {
    userId: "u1",
    paginationOpts: { numItems: 2, cursor: null },
  });
  expect(first.page.map((n) => n.payload)).toEqual(["3", "2"]);
  expect(first.isDone).toBe(false);
  const second = await t.query(api.notifications.listForUser, {
    userId: "u1",
    paginationOpts: { numItems: 2, cursor: first.continueCursor },
  });
  expect(second.page.map((n) => n.payload)).toEqual(["1"]);
});

test("a subscription reassigned before delivery never receives the old user's payload", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  const alice = await subscribe(t, "alice");
  const id = await t.mutation(api.notifications.send, { userId: "alice", payload: "secret" });
  await t.mutation(api.subscriptions.record, { userId: "bob", subscription: alice.subscription });
  await drain(t);
  expect(mock).not.toHaveBeenCalled();
  const deliveries = await t.query(api.deliveries.listForNotification, {
    notificationId: required(id),
  });
  expect(deliveries[0]).toMatchObject({ status: "failed", errorKind: "reassigned" });
  const row = await t.run((ctx) => ctx.db.query("subscriptions").first());
  expect(row).toMatchObject({ userId: "bob", status: "active", consecutiveFailures: 0 });
  expect(row?.lastFailureAt).toBeUndefined();
});

test("a large batch continues in scheduled mutations within a delivery budget", async () => {
  const t = setupTest();
  const users = ["u1", "u2", "u3", "u4"];
  await subscribeBatch(t, users, [50, 50, 50, 1]);
  const first = await t.mutation(api.notifications.sendBatch, { userIds: users, payload: "x" });
  expect(first.done).toBe(false);
  expect(first.results).toHaveLength(3);
  expect(await t.query(api.notifications.getBatch, { batchId: first.batchId })).toMatchObject({
    status: "running",
    total: 4,
    processed: 3,
  });
  await drain(t);
  const batch = await t.query(api.notifications.getBatch, { batchId: first.batchId });
  expect(batch).toMatchObject({ status: "done", processed: 4 });
  expect(batch?.notificationIds).toHaveLength(4);
  const rows = await t.run((ctx) => ctx.db.query("notifications").collect());
  expect(
    rows.every((n) => n.status === "delivered" && n.counts.sent === (n.userId === "u4" ? 1 : 50)),
  ).toBe(true);
});

test("the remaining TTL is sent on every attempt", async () => {
  await configureVapid();
  const fetched = stubFetch(respond(503), respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t, "u1");
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x", ttl: 100_000 });
  const { notification } = await finished(t, required(id));
  expect(fetched.calls).toHaveLength(2);
  const first = Number(fetched.headers(0).get("TTL"));
  const second = Number(fetched.headers(1).get("TTL"));
  expect(first).toBeLessThanOrEqual(100_000);
  expect(second).toBeLessThan(first);
  expect(second).toBeGreaterThan(0);
  expect(notification.status).toBe("delivered");
});

test("TTL 0 is sent once with TTL 0 and never retried", async () => {
  await configureVapid();
  const fetched = stubFetch(respond(503));
  const t = setupTest({ testMode: false });
  await subscribe(t, "u1");
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x", ttl: 0 });
  const { deliveries } = await finished(t, required(id));
  expect(fetched.calls.map((_, n) => fetched.headers(n).get("TTL"))).toEqual(["0"]);
  expect(deliveries[0]).toMatchObject({ status: "failed", errorKind: "ttl_expired", attempts: 1 });
});

test("a message already expired before its first attempt is not sent", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t, "u1");
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x", ttl: 60 });
  vi.setSystemTime(Date.now() + 120_000);
  const { deliveries } = await finished(t, required(id));
  expect(mock).not.toHaveBeenCalled();
  expect(deliveries[0]).toMatchObject({ status: "failed", errorKind: "ttl_expired" });
});

test("a Retry-After longer than a day is honoured when the TTL allows it", async () => {
  await configureVapid();
  const { calls } = stubFetch(respond(429, { "Retry-After": "172800" }), respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t, "u1");
  await t.mutation(api.notifications.send, { userId: "u1", payload: "x", ttl: 2_000_000 });
  await drain(t);
  expect(calls).toHaveLength(2);
  expect(required(calls[1]).time - required(calls[0]).time).toBeGreaterThanOrEqual(172_800_000);
});

test("begin computes the remaining TTL in whole seconds", async () => {
  const t = setupTest();
  await subscribe(t, "u1");
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x", ttl: 600 });
  const [delivery] = await t.query(api.deliveries.listForNotification, {
    notificationId: required(id),
  });
  vi.setSystemTime(Date.now() + 100_500);
  const job = await t.mutation(internal.deliveries.begin, {
    deliveryId: required(delivery)._id,
  });
  expect(job).toMatchObject({ ok: true, ttl: 499 });
});

test("an invalid WEB_PUSH_MAX_PARALLELISM is a configuration error, even in test mode", async () => {
  const t = setupTest();
  await subscribe(t);
  vi.stubEnv("WEB_PUSH_MAX_PARALLELISM", "0");
  await expectWebPushError(
    t.mutation(api.notifications.send, { userId: "u1", payload: "x" }),
    "WEB_PUSH_NOT_CONFIGURED",
  );
  vi.stubEnv("WEB_PUSH_MAX_PARALLELISM", "3");
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  expect((await finished(t, required(id))).notification.status).toBe("delivered");
});

test("a retry still runs if the parallelism setting became invalid after the send", async () => {
  await configureVapid();
  stubFetch(respond(503), respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  vi.stubEnv("WEB_PUSH_MAX_PARALLELISM", "5");
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  vi.stubEnv("WEB_PUSH_MAX_PARALLELISM", "nope");
  const { deliveries } = await finished(t, required(id));
  expect(deliveries[0]).toMatchObject({ status: "sent", attempts: 2 });
});

test.each([
  ["paused", "subscription_paused", "failed"],
  ["gone", "subscription_gone", "gone"],
] as const)(
  "a subscription that is %s by delivery time is not sent to",
  async (state, kind, status) => {
    await configureVapid();
    const { mock } = stubFetch(respond(201));
    const t = setupTest({ testMode: false });
    await subscribe(t);
    const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
    await t.run(async (ctx) => {
      const row = required(await ctx.db.query("subscriptions").first());
      await ctx.db.patch("subscriptions", row._id, { status: state });
    });
    const { deliveries } = await finished(t, required(id));
    expect(mock).not.toHaveBeenCalled();
    expect(deliveries[0]).toMatchObject({ status, errorKind: kind });
  },
);

test("a subscription that expires before delivery is marked gone", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  const sub = await makeSubscription();
  await t.mutation(api.subscriptions.record, {
    userId: "u1",
    subscription: { ...sub.subscription, expirationTime: Date.now() + 60_000 },
  });
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  vi.setSystemTime(Date.now() + 120_000);
  const { deliveries } = await finished(t, required(id));
  expect(mock).not.toHaveBeenCalled();
  expect(deliveries[0]).toMatchObject({ status: "gone", errorKind: "subscription_expired" });
});

test("a delivery whose notification was deleted ends without sending", async () => {
  const t = setupTest();
  await subscribe(t);
  const id = required(await t.mutation(api.notifications.send, { userId: "u1", payload: "x" }));
  await t.run((ctx) => ctx.db.delete("notifications", id));
  await drain(t);
  const rows = await t.run((ctx) => ctx.db.query("deliveries").collect());
  expect(rows[0]).toMatchObject({ status: "failed", errorKind: "notification_missing" });
});

test("begin skips a delivery that already finished", async () => {
  const t = setupTest();
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  const { deliveries } = await finished(t, required(id));
  const job = await t.mutation(internal.deliveries.begin, {
    deliveryId: required(deliveries[0])._id,
  });
  expect(job).toMatchObject({ ok: false, outcome: { errorKind: "delivery_closed" } });
});

/** The workpool id is only read by workpool itself; these tests invoke the callback directly. */
const workId = "work" as WorkId;

type WorkResult =
  | { kind: "success"; returnValue: unknown }
  | { kind: "failed"; error: string }
  | { kind: "canceled" };

async function queuedDelivery(t: TestCtx) {
  await subscribe(t);
  const id = required(await t.mutation(api.notifications.send, { userId: "u1", payload: "x" }));
  const rows = await t.run((ctx) => ctx.db.query("deliveries").collect());
  return { id, deliveryId: required(rows[0])._id };
}

test("a failed workpool result is retried, a canceled one is not, a garbled one is retried", async () => {
  const t = setupTest();
  const { id, deliveryId } = await queuedDelivery(t);
  const complete = (result: WorkResult) =>
    t.mutation(internal.deliveries.onComplete, {
      workId,
      context: { deliveryId },
      result,
    });
  await complete({ kind: "failed", error: "boom" });
  const retried = await t.run((ctx) => ctx.db.get("deliveries", deliveryId));
  expect(retried).toMatchObject({ status: "retry", errorKind: "action_failed", attempts: 1 });

  await complete({ kind: "success", returnValue: "not an outcome" });
  expect(await t.run((ctx) => ctx.db.get("deliveries", deliveryId))).toMatchObject({
    status: "retry",
    errorKind: "invalid_result",
    attempts: 2,
  });

  await complete({ kind: "canceled" });
  const { notification, deliveries } = await finished(t, id);
  expect(deliveries[0]).toMatchObject({ status: "failed", errorKind: "canceled", attempts: 3 });
  expect(notification.status).toBe("failed");
});

test("a delivery finished twice is only counted once", async () => {
  const t = setupTest();
  const { id, deliveryId } = await queuedDelivery(t);
  const done = {
    workId,
    context: { deliveryId },
    result: { kind: "success", returnValue: { kind: "sent", statusCode: 201 } },
  } as const;
  await t.mutation(internal.deliveries.onComplete, done);
  await t.mutation(internal.deliveries.onComplete, done);
  const notification = await t.query(api.notifications.get, { notificationId: id });
  expect(notification?.counts).toEqual({ queued: 0, sent: 1, failed: 0, gone: 0 });
});

test("VAPID settings that disappear after queueing fail the delivery without sending", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
  const { deliveries } = await finished(t, required(id));
  expect(mock).not.toHaveBeenCalled();
  expect(deliveries[0]).toMatchObject({
    status: "failed",
    errorKind: "vapid_not_configured",
    detail: "VAPID_PRIVATE_KEY is not set",
  });
});

test("a key pair that cannot be imported fails permanently without echoing it", async () => {
  const keys = await configureVapid();
  const { mock } = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const id = await t.mutation(api.notifications.send, { userId: "u1", payload: "x" });
  // A well-formed 65-byte point that is not on the curve passes the config check but not the import.
  const offCurve = base64urlEncode(new Uint8Array([4, ...new Uint8Array(64).fill(1)]));
  vi.stubEnv("VAPID_PUBLIC_KEY", offCurve);
  const { deliveries } = await finished(t, required(id));
  expect(mock).not.toHaveBeenCalled();
  expect(deliveries[0]).toMatchObject({ status: "gone", errorKind: "vapid_key_mismatch" });
  expect(JSON.stringify(deliveries)).not.toContain(keys.privateKey);
});

test("a batch never puts more than 150 deliveries in one transaction", async () => {
  const t = setupTest();
  const counts = [49, 50, 50, 2];
  const users = counts.map((_, i) => `cap${i}`);
  await subscribeBatch(t, users, counts);
  const first = await t.mutation(api.notifications.sendBatch, { userIds: users, payload: "x" });
  // 49 + 50 + 50 = 149 fits; the fourth user would make 151, so it waits for the continuation.
  expect(first.results.map((r) => r.userId)).toEqual(users.slice(0, 3));
  expect(first.done).toBe(false);
  expect(await t.run((ctx) => ctx.db.query("deliveries").collect())).toHaveLength(149);
  // The large-batch test above covers scheduled workpool completion; this test isolates the
  // transaction boundary and the continuation's row count.
  await t.mutation(internal.notifications.continueBatch, { batchId: first.batchId });
  expect(await t.run((ctx) => ctx.db.query("deliveries").collect())).toHaveLength(151);
  const batch = await t.query(api.notifications.getBatch, { batchId: first.batchId });
  expect(batch).toMatchObject({ status: "done", processed: 4 });
});

test("a batch that exactly fills the budget finishes in one call", async () => {
  const t = setupTest();
  const users = ["a", "b", "c"];
  await subscribeBatch(t, users, [50, 50, 50]);
  const first = await t.mutation(api.notifications.sendBatch, { userIds: users, payload: "x" });
  expect(first).toMatchObject({ done: true });
  expect(first.results).toHaveLength(3);
  expect(await t.run((ctx) => ctx.db.query("deliveries").collect())).toHaveLength(150);
});

test("a user with the maximum 50 subscriptions always fits an empty budget", async () => {
  const t = setupTest();
  await subscribeBatch(t, ["big"], [50]);
  const first = await t.mutation(api.notifications.sendBatch, { userIds: ["big"], payload: "x" });
  expect(first.done).toBe(true);
  expect(first.results[0]?.notificationId).not.toBeNull();
});

test("a failed notification releases its idempotency key so a retry sends", async () => {
  await configureVapid();
  const fetched = stubFetch(respond(410), respond(201));
  const t = setupTest({ testMode: false });
  await subscribe(t);
  const first = await t.mutation(api.notifications.send, {
    userId: "u1",
    payload: "x",
    idempotencyKey: "order-1",
  });
  const failed = await finished(t, required(first));
  expect(failed.notification.status).toBe("failed");
  expect(failed.notification.idempotencyKey).toBeUndefined();

  await subscribe(t);
  const retry = await t.mutation(api.notifications.send, {
    userId: "u1",
    payload: "x",
    idempotencyKey: "order-1",
  });
  expect(retry).not.toBeNull();
  expect(retry).not.toBe(first);
  expect((await finished(t, required(retry))).notification.status).toBe("delivered");
  expect(fetched.mock).toHaveBeenCalledTimes(2);

  // The delivered notification keeps its key.
  const again = await t.mutation(api.notifications.send, {
    userId: "u1",
    payload: "x",
    idempotencyKey: "order-1",
  });
  expect(again).toBe(retry);
});

const batchAcrossDeliveryBudget = async (t: TestCtx) => {
  const users = ["m0", "m1", "m2", "m3"];
  await subscribeBatch(t, users, [50, 50, 50, 1]);
  return t.mutation(api.notifications.sendBatch, { userIds: users, payload: "x" });
};

test("a test-mode batch stays in test mode when the env changes mid-batch", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(201));
  const t = setupTest();
  const first = await batchAcrossDeliveryBudget(t);
  expect(first.done).toBe(false);
  expect(first.results).toHaveLength(3);
  expect(await t.query(api.notifications.getBatch, { batchId: first.batchId })).toMatchObject({
    status: "running",
    processed: 3,
  });
  vi.stubEnv("WEB_PUSH_TEST_MODE", undefined);
  // The scheduled continuation/workpool path is covered by the large-batch test above. Run this
  // continuation plus one initial and one continued delivery directly to isolate the captured mode.
  await t.mutation(internal.notifications.continueBatch, { batchId: first.batchId });
  const initialDelivery = await deliveryForUser(t, "m0");
  const lastDelivery = await deliveryForUser(t, "m3");
  expect(
    await t.action(internal.deliver.run, { deliveryId: required(initialDelivery)._id }),
  ).toEqual({ kind: "sent", statusCode: 0 });
  expect(await t.action(internal.deliver.run, { deliveryId: required(lastDelivery)._id })).toEqual({
    kind: "sent",
    statusCode: 0,
  });
  expect(mock).not.toHaveBeenCalled();
  const rows = await t.run((ctx) => ctx.db.query("notifications").collect());
  expect(rows).toHaveLength(4);
  expect(rows.every((n) => n.testMode === true)).toBe(true);
  const deliveries = await t.run((ctx) => ctx.db.query("deliveries").collect());
  expect(deliveries.every((d) => d.testMode === true)).toBe(true);
  expect(deliveries).toHaveLength(151);
  expect(await t.query(api.notifications.getBatch, { batchId: first.batchId })).toMatchObject({
    status: "done",
    processed: 4,
  });
});

test("a real batch stays real when test mode is switched on mid-batch", async () => {
  await configureVapid();
  const { mock } = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  const first = await batchAcrossDeliveryBudget(t);
  expect(first.done).toBe(false);
  expect(first.results).toHaveLength(3);
  expect(await t.query(api.notifications.getBatch, { batchId: first.batchId })).toMatchObject({
    status: "running",
    processed: 3,
  });
  vi.stubEnv("WEB_PUSH_TEST_MODE", "true");
  // The scheduled continuation/workpool path is covered by the large-batch test above. Run this
  // continuation plus one initial and one continued delivery directly to isolate the captured mode.
  await t.mutation(internal.notifications.continueBatch, { batchId: first.batchId });
  const initialDelivery = await deliveryForUser(t, "m0");
  const lastDelivery = await deliveryForUser(t, "m3");
  expect(
    await t.action(internal.deliver.run, { deliveryId: required(initialDelivery)._id }),
  ).toEqual({ kind: "sent", statusCode: 201 });
  expect(await t.action(internal.deliver.run, { deliveryId: required(lastDelivery)._id })).toEqual({
    kind: "sent",
    statusCode: 201,
  });
  const rows = await t.run((ctx) => ctx.db.query("notifications").collect());
  expect(rows).toHaveLength(4);
  expect(rows.every((n) => n.testMode === undefined)).toBe(true);
  expect(mock).toHaveBeenCalledTimes(2);
  const deliveries = await t.run((ctx) => ctx.db.query("deliveries").collect());
  expect(deliveries).toHaveLength(151);
  expect(deliveries.every((d) => d.testMode === undefined)).toBe(true);
  expect(await t.query(api.notifications.getBatch, { batchId: first.batchId })).toMatchObject({
    status: "done",
    processed: 4,
  });
});
