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

// The example app wraps every public client method, so driving it calls each of them.
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
  await t.mutation(internal.admin.saveSubscription, { userId, subscription, userAgent: "Vitest" });
  return subscription;
}

const page = (t: Harness, userId: string, numItems = 10, cursor: string | null = null) =>
  t.query(internal.admin.notifications, { userId, paginationOpts: { numItems, cursor } });

/** A ctx that records what the client sends, then stops before any component runs. */
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

test("recordSubscription, getStatusForUser, pauseNotifications and resumeNotifications", async () => {
  const t = setup();
  expect(await t.query(internal.admin.userStatus, { userId: "u1" })).toEqual({
    subscriptions: 0,
    paused: 0,
  });
  await subscribe(t, "u1");
  expect(await t.query(internal.admin.userStatus, { userId: "u1" })).toEqual({
    subscriptions: 1,
    paused: 0,
  });
  expect(await t.mutation(internal.admin.pause, { userId: "u1" })).toBe(1);
  expect(await t.mutation(internal.admin.notify, { userId: "u1", title: "x" })).toBeNull();
  expect(await t.mutation(internal.admin.resume, { userId: "u1" })).toBe(1);
  expect(await t.mutation(internal.admin.notify, { userId: "u1", title: "x" })).not.toBeNull();
});

test("recordSubscription rejects an invalid subscription with a typed error", async () => {
  const t = setup();
  const { subscription } = await makeSubscription("evil.example.com");
  await expectWebPushError(
    t.mutation(internal.admin.saveSubscription, { userId: "u1", subscription }),
    "WEB_PUSH_INVALID_SUBSCRIPTION",
  );
});

test("sendNotification sends ttl, urgency, topic and the serialized notification", async () => {
  const t = setup();
  await subscribe(t, "u1");
  const id = required(
    await t.mutation(internal.admin.notify, {
      userId: "u1",
      title: "Hi",
      ttl: 600,
      urgency: "high",
      topic: "unread",
    }),
  );
  const notification = required(await t.query(internal.admin.notification, { notificationId: id }));
  expect(notification.options).toEqual({ ttl: 600, urgency: "high", topic: "unread" });
  expect(JSON.parse(notification.payload)).toEqual({ title: "Hi" });
});

test("getNotification and getDeliveries follow a notification to delivered", async () => {
  const t = setup();
  await subscribe(t, "u1");
  const id = required(await t.mutation(internal.admin.notify, { userId: "u1", title: "Hi" }));
  await drain(t);
  expect(await t.query(internal.admin.notification, { notificationId: id })).toMatchObject({
    status: "delivered",
    counts: { queued: 0, sent: 1, failed: 0, gone: 0 },
    testMode: true,
  });
  expect(await t.query(internal.admin.deliveries, { notificationId: id })).toEqual([
    { status: "sent", attempts: 1 },
  ]);
});

test("getNotificationsForUser pages newest first", async () => {
  const t = setup();
  await subscribe(t, "u1");
  for (const title of ["one", "two", "three"]) {
    vi.setSystemTime(Date.now() + 1000);
    await t.mutation(internal.admin.notify, { userId: "u1", title });
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
    await t.mutation(internal.admin.notifyRaw, { userId: "u1", payload: "custom:42" }),
  );
  const bytes = new Uint8Array([0, 255, 128, 7]);
  const binary = required(
    await t.mutation(internal.admin.notifyRaw, { userId: "u1", payload: bytes.buffer }),
  );
  expect((await t.query(internal.admin.notification, { notificationId: text }))?.payload).toBe(
    "custom:42",
  );
  expect((await t.query(internal.admin.notification, { notificationId: binary }))?.payload).toBe(
    base64urlEncode(bytes),
  );
});

test("sendNotificationBatch reports progress through getBatch and continues past the budget", async () => {
  const t = setup();
  const userIds = Array.from({ length: 80 }, (_, i) => `u${i}`);
  for (const userId of userIds) {
    await subscribe(t, userId);
    await subscribe(t, userId);
  }
  const first = await t.mutation(internal.admin.broadcast, { userIds, title: "News" });
  expect(first.done).toBe(false);
  expect(first.results.length).toBeLessThan(userIds.length);
  expect(await t.query(internal.admin.batchProgress, { batchId: first.batchId })).toMatchObject({
    status: "running",
    total: 80,
  });
  await drain(t);
  const done = required(await t.query(internal.admin.batchProgress, { batchId: first.batchId }));
  expect(done).toMatchObject({ status: "done", processed: 80 });
  expect(done.notificationIds).toHaveLength(80);
});

test("sendNotificationBatch rejects more than 100 users with a typed error", async () => {
  const t = setup();
  await expectWebPushError(
    t.mutation(internal.admin.broadcast, {
      userIds: Array.from({ length: 101 }, (_, i) => `u${i}`),
      title: "x",
    }),
    "WEB_PUSH_BATCH_TOO_LARGE",
  );
});

test("removeSubscription only removes for the matching user, removeAllForUser clears the rest", async () => {
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
  expect(await t.mutation(internal.admin.removeAllForUser, { userId: "alice" })).toEqual({
    removed: 1,
    done: true,
  });
  expect((await t.query(internal.admin.userStatus, { userId: "alice" })).subscriptions).toBe(0);
});

test("getPublicKey is null until configured, and selfTest reports the runtime", async () => {
  const t = setup();
  expect(await t.query(api.example.publicKey, {})).toBeNull();
  const keys = await configureVapid();
  expect(await t.query(api.example.publicKey, {})).toBe(keys.publicKey);
  const report = await t.action(internal.admin.selfTest, {});
  expect(report).toMatchObject({ ok: true, testMode: false, config: { configured: true } });
});

test("an oversized notification fails on the client with the same error shape", async () => {
  const t = setup();
  await subscribe(t, "u1");
  await expectWebPushError(
    t.mutation(internal.admin.notify, {
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

  await expect(client.recordSubscription(ctx, { userId: "u1", subscription })).rejects.toBe(stop);
  expect(lastArgs()).toMatchObject({ allowedPushHosts: ["push.example.test"], userId: "u1" });

  await expect(
    client.sendRaw(ctx, { userId: "u1", payload: "raw", options: { topic: "t" } }),
  ).rejects.toBe(stop);
  expect(lastArgs()).toEqual({
    userId: "u1",
    payload: "raw",
    topic: "t",
    testMode: true,
    allowedPushHosts: ["push.example.test"],
  });

  await expect(
    client.sendNotificationBatch(ctx, { userIds: ["a"], notification: { title: "x" } }),
  ).rejects.toBe(stop);
  expect(lastArgs()).toEqual({
    userIds: ["a"],
    payload: '{"title":"x"}',
    testMode: true,
    allowedPushHosts: ["push.example.test"],
  });
});

test("a plain client leaves optional arguments out instead of sending undefined", async () => {
  const client = new WebPush(components.webPush);
  const { ctx, stop, lastArgs } = recorder();
  await expect(
    client.sendNotification(ctx, { userId: "u1", notification: { title: "x" } }),
  ).rejects.toBe(stop);
  expect(lastArgs()).toStrictEqual({ userId: "u1", payload: '{"title":"x"}' });
  await expect(client.getStatusForUser(ctx, { userId: "u1" })).rejects.toBe(stop);
  expect(lastArgs()).toStrictEqual({ userId: "u1" });
});

test("isWebPushError is exported for apps and rejects other errors", () => {
  expect(isWebPushError(new Error("WEB_PUSH_NOT_CONFIGURED"))).toBe(false);
});
