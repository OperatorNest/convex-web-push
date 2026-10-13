import { register } from "@operatornest/convex-web-push/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, components, internal } from "../../example/convex/_generated/api.js";
import schema from "../../example/convex/schema.js";
import { base64urlEncode } from "../shared/base64url.js";
import {
  configureVapid,
  drain,
  expectWebPushError,
  makeSubscription,
  required,
} from "../test-helpers.js";
import { isWebPushError, MAX_PLAINTEXT_BYTES, WebPush } from "./index.js";

const modules = import.meta.glob("../../example/convex/**/*.ts");

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function setup() {
  vi.stubEnv("WEB_PUSH_TEST_MODE", "true");
  const t = convexTest(schema, modules);
  register(t);
  return t;
}

type Harness = ReturnType<typeof setup>;

async function subscribe(t: Harness, userId: string) {
  const { subscription } = await makeSubscription();
  await t.mutation(internal.admin.recordSubscription, {
    userId,
    subscription,
    userAgent: "Vitest",
  });
  return subscription;
}

const page = (t: Harness, userId: string, numItems = 10, continueCursor: string | null = null) =>
  t.query(internal.admin.listNotifications, {
    userId,
    paginationOpts: { numItems, cursor: continueCursor },
  });

function recorder() {
  const stop = new Error("recorded");
  const calls: { ref: unknown; args: unknown }[] = [];
  const record = async (ref: unknown, ...args: unknown[]): Promise<never> => {
    calls.push({ ref, args: args[0] });
    throw stop;
  };
  return {
    ctx: { runQuery: record, runMutation: record, runAction: record },
    stop,
    lastArgs: () => required(calls.at(-1), "a recorded call").args,
  };
}

test("recording, pausing and resuming a subscription updates its stored counts", async () => {
  const t = setup();
  expect(await t.query(internal.admin.getSubscriptionStatus, { userId: "u1" })).toEqual({
    activeCount: 0,
    pausedCount: 0,
  });
  await subscribe(t, "u1");
  expect(await t.query(internal.admin.getSubscriptionStatus, { userId: "u1" })).toEqual({
    activeCount: 1,
    pausedCount: 0,
  });
  expect(await t.mutation(internal.admin.pauseSubscriptions, { userId: "u1" })).toBe(1);
  expect(
    await t.mutation(internal.admin.sendNotification, { userId: "u1", title: "x" }),
  ).toBeNull();
  expect(await t.mutation(internal.admin.resumeSubscriptions, { userId: "u1" })).toBe(1);
  expect(
    await t.mutation(internal.admin.sendNotification, { userId: "u1", title: "x" }),
  ).not.toBeNull();
});

test("recordSubscription rejects an invalid subscription with a typed error", async () => {
  const t = setup();
  const { subscription } = await makeSubscription("evil.example.com");
  await expectWebPushError(
    t.mutation(internal.admin.recordSubscription, { userId: "u1", subscription }),
    "WEB_PUSH_INVALID_ARGUMENT",
  );
});

test("sendNotification sends ttlSeconds, urgency, topic and the serialized notification", async () => {
  const t = setup();
  await subscribe(t, "u1");
  const id = required(
    await t.mutation(internal.admin.sendNotification, {
      userId: "u1",
      title: "Hi",
      ttlSeconds: 600,
      urgency: "high",
      topic: "unread",
    }),
    "the notification id",
  );
  const notification = required(
    await t.query(internal.admin.getNotification, { notificationId: id, userId: "u1" }),
    "the notification",
  );
  expect(notification.options).toEqual({ ttlSeconds: 600, urgency: "high", topic: "unread" });
  expect(JSON.parse(notification.payload)).toEqual({ title: "Hi" });
});

test("getNotification and getDeliveries follow a notification to delivered", async () => {
  const t = setup();
  await subscribe(t, "u1");
  const id = required(
    await t.mutation(internal.admin.sendNotification, { userId: "u1", title: "Hi" }),
    "the notification id",
  );
  await drain(t);
  expect(
    await t.query(internal.admin.getNotification, { notificationId: id, userId: "u1" }),
  ).toMatchObject({
    status: "delivered",
    counts: { queued: 0, sent: 1, failed: 0, gone: 0 },
    testMode: true,
  });
  expect(
    await t.query(internal.admin.listDeliveries, { notificationId: id, userId: "u1" }),
  ).toEqual([{ status: "sent", attempts: 1 }]);
});

test("getNotificationsForUser pages newest first", async () => {
  const t = setup();
  await subscribe(t, "u1");
  for (const title of ["one", "two", "three"]) {
    vi.setSystemTime(Date.now() + 1000);
    await t.mutation(internal.admin.sendNotification, { userId: "u1", title });
  }
  const first = await page(t, "u1", 2);
  expect(first.page.map((n) => JSON.parse(n.payload).title)).toEqual(["three", "two"]);
  expect(first.isDone).toBe(false);
  const second = await page(t, "u1", 2, first.continueCursor);
  expect(second.page.map((n) => JSON.parse(n.payload).title)).toEqual(["one"]);
});

test("sendRaw sends a string as is and bytes as base64url", async () => {
  const t = setup();
  await subscribe(t, "u1");
  const text = required(
    await t.mutation(internal.admin.sendRawNotification, { userId: "u1", payload: "custom:42" }),
    "the notification id",
  );
  const bytes = new Uint8Array([0, 255, 128, 7]);
  const binary = required(
    await t.mutation(internal.admin.sendRawNotification, { userId: "u1", payload: bytes.buffer }),
    "the notification id",
  );
  expect(
    (await t.query(internal.admin.getNotification, { notificationId: text, userId: "u1" }))
      ?.payload,
  ).toBe("custom:42");
  expect(
    (await t.query(internal.admin.getNotification, { notificationId: binary, userId: "u1" }))
      ?.payload,
  ).toBe(base64urlEncode(bytes));
});

test("sendNotificationBatch reports progress through getBatch and continues past the budget", async () => {
  const t = setup();
  const userIds = Array.from({ length: 80 }, (_, i) => `u${i}`);
  for (const userId of userIds) {
    await subscribe(t, userId);
    await subscribe(t, userId);
  }
  const first = await t.mutation(internal.admin.sendBatch, { userIds, title: "News" });
  expect(first.done).toBe(false);
  expect(first.results.length).toBeLessThan(userIds.length);
  expect(await t.query(internal.admin.getBatch, { batchId: first.batchId })).toMatchObject({
    status: "running",
    total: 80,
  });
  await drain(t);
  const done = required(
    await t.query(internal.admin.getBatch, { batchId: first.batchId }),
    "the batch",
  );
  expect(done).toMatchObject({ status: "done", processed: 80 });
  expect(done.notificationIds).toHaveLength(80);
});

test("sendNotificationBatch rejects more than 100 users with a typed error", async () => {
  const t = setup();
  await expectWebPushError(
    t.mutation(internal.admin.sendBatch, {
      userIds: Array.from({ length: 101 }, (_, i) => `u${i}`),
      title: "x",
    }),
    "WEB_PUSH_INVALID_ARGUMENT",
  );
});

test("removeSubscription only removes for the matching user, removeAll clears the rest", async () => {
  const t = setup();
  const subscription = await subscribe(t, "alice");
  await subscribe(t, "alice");
  expect(
    await t.mutation(internal.admin.removeSubscription, {
      endpoint: subscription.endpoint,
      userId: "bob",
    }),
  ).toBe(false);
  expect(
    await t.mutation(internal.admin.removeSubscription, {
      endpoint: subscription.endpoint,
      userId: "alice",
    }),
  ).toBe(true);
  expect(await t.mutation(internal.admin.removeAll, { userId: "alice" })).toEqual({
    removed: 1,
    done: true,
  });
  expect(
    (await t.query(internal.admin.getSubscriptionStatus, { userId: "alice" })).activeCount,
  ).toBe(0);
});

test("config.get returns a null key until configured, and config.verify reports the runtime", async () => {
  const t = setup();
  const reader = t.withIdentity({ tokenIdentifier: "reader" });
  expect(await reader.query(api.example.getConfig, {})).toEqual({ applicationServerKey: null });
  const keys = await configureVapid();
  expect(await reader.query(api.example.getConfig, {})).toEqual({
    applicationServerKey: keys.publicKey,
  });
  const report = await t.action(internal.admin.verifyConfig, {});
  expect(report).toMatchObject({ ok: true, testMode: false, config: { configured: true } });
});

test("an oversized notification fails on the client with the same error shape", async () => {
  const t = setup();
  await subscribe(t, "u1");
  await expectWebPushError(
    t.mutation(internal.admin.sendNotification, {
      userId: "u1",
      title: "x",
      body: "a".repeat(MAX_PLAINTEXT_BYTES),
    }),
    "WEB_PUSH_PAYLOAD_TOO_LARGE",
  );
});

test("the client forwards allowedPushHosts and testMode to every call", async () => {
  const client = new WebPush(components.webPush, {
    testMode: true,
    allowedPushHosts: ["push.example.test"],
  });
  const { ctx, stop, lastArgs } = recorder();
  const { subscription } = await makeSubscription("push.example.test");

  await expect(client.subscriptions.record(ctx, { userId: "u1", subscription })).rejects.toBe(stop);
  expect(lastArgs()).toMatchObject({ allowedPushHosts: ["push.example.test"], userId: "u1" });

  await expect(
    client.notifications.sendRaw(ctx, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      payload: "raw",
      topic: "t",
    }),
  ).rejects.toBe(stop);
  expect(lastArgs()).toEqual({
    userId: "u1",
    payload: "raw",
    ttlSeconds: 86400,
    urgency: "normal",
    topic: "t",
    testMode: true,
    allowedPushHosts: ["push.example.test"],
  });

  await expect(
    client.notifications.sendBatch(ctx, {
      ttlSeconds: 86400,
      urgency: "normal",
      userIds: ["a"],
      notification: { title: "x" },
    }),
  ).rejects.toBe(stop);
  expect(lastArgs()).toEqual({
    userIds: ["a"],
    payload: '{"title":"x"}',
    ttlSeconds: 86400,
    urgency: "normal",
    testMode: true,
    allowedPushHosts: ["push.example.test"],
  });
});

test("a plain client passes omitted optional arguments as undefined", async () => {
  const client = new WebPush(components.webPush);
  const { ctx, stop, lastArgs } = recorder();
  await expect(
    client.notifications.send(ctx, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u1",
      notification: { title: "x" },
    }),
  ).rejects.toBe(stop);
  expect(lastArgs()).toStrictEqual({
    userId: "u1",
    payload: '{"title":"x"}',
    payloadEncoding: undefined,
    ttlSeconds: 86400,
    urgency: "normal",
    topic: undefined,
    idempotencyKey: undefined,
    onComplete: undefined,
    testMode: undefined,
    allowedPushHosts: undefined,
  });
  await expect(client.subscriptions.getStatus(ctx, { userId: "u1" })).rejects.toBe(stop);
  expect(lastArgs()).toStrictEqual({ testMode: undefined, userId: "u1" });
});

test("config methods take only ctx and forward the client's test-mode option", async () => {
  const { ctx, stop, lastArgs } = recorder();
  const plain = new WebPush(components.webPush);
  await expect(plain.config.get(ctx)).rejects.toBe(stop);
  expect(lastArgs()).toStrictEqual({ testMode: undefined });
  const simulated = new WebPush(components.webPush, { testMode: true });
  await expect(simulated.config.verify(ctx)).rejects.toBe(stop);
  expect(lastArgs()).toStrictEqual({ testMode: true });
});

test("isWebPushError is exported for apps and rejects other errors", () => {
  expect(isWebPushError(new Error("WEB_PUSH_NOT_CONFIGURED"))).toBe(false);
});

test("recordSubscription discards undeclared endpoint policy", async () => {
  const client = new WebPush(components.webPush);
  const { ctx, stop, lastArgs } = recorder();
  const { subscription } = await makeSubscription();
  const args = { userId: "u", subscription, allowedPushHosts: ["evil.example.com"] };
  await expect(client.subscriptions.record(ctx, args)).rejects.toBe(stop);
  expect(lastArgs()).toMatchObject({ allowedPushHosts: undefined });
});
test("sendRaw rejects oversized text and bytes before calling the component", async () => {
  const client = new WebPush(components.webPush);
  const { ctx } = recorder();
  for (const payload of [
    "x".repeat(MAX_PLAINTEXT_BYTES + 1),
    new Uint8Array(MAX_PLAINTEXT_BYTES + 1),
  ]) {
    await expectWebPushError(
      client.notifications.sendRaw(ctx, {
        ttlSeconds: 86400,
        urgency: "normal",
        userId: "u",
        payload,
      }),
      "WEB_PUSH_PAYLOAD_TOO_LARGE",
    );
  }
});

test.each([false, true])(
  "batch callback reports terminal failure=%s once through the app",
  async (failed) => {
    const t = setup();
    const userIds = Array.from({ length: 80 }, (_, i) => `u${i}`);
    for (const userId of userIds) {
      await subscribe(t, userId);
      await subscribe(t, userId);
    }
    const first = await t.mutation(internal.admin.sendBatch, { userIds, title: "News" });
    expect(first.done).toBe(false);
    if (failed) vi.stubEnv("WEB_PUSH_MAX_PARALLELISM", "0");
    await drain(t);
    if (failed) vi.stubEnv("WEB_PUSH_MAX_PARALLELISM", undefined);
    const progress = required(
      await t.query(internal.admin.getBatch, { batchId: first.batchId }),
      "the batch",
    );
    expect(progress.status).toBe(failed ? "failed" : "done");
    const results = await t.run((ctx) =>
      ctx.db
        .query("batchResults")
        .withIndex("by_batchId", (q) => q.eq("batchId", first.batchId))
        .take(2),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ batchId: first.batchId, ...progress });
    if (failed) expect(results[0]?.errorCode).toBe("WEB_PUSH_NOT_CONFIGURED");
    else expect(results[0]?.errorCode).toBeUndefined();
  },
);
