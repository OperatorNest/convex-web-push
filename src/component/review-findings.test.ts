import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
  configureVapid,
  makeSubscription,
  required,
  respond,
  setupTest,
  stubFetch,
} from "../test-helpers.js";
import { generateVapidKeys, importVapidPrivateKey } from "../shared/vapid.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("mismatched VAPID keys fail before any push request", async () => {
  await configureVapid();
  const other = await generateVapidKeys();
  const otherKey = await importVapidPrivateKey(other.publicKey, other.privateKey);
  vi.stubEnv("VAPID_PRIVATE_KEY", other.privateKey);
  const fetched = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  const { subscription } = await makeSubscription();
  await t.mutation(api.subscriptions.record, { userId: "alice", subscription });
  const notificationId = required(
    await t.mutation(api.notifications.send, { userId: "alice", payload: "x" }),
  );
  const delivery = required(
    await t.run((ctx) =>
      ctx.db
        .query("deliveries")
        .withIndex("by_notificationId", (q) => q.eq("notificationId", notificationId))
        .first(),
    ),
  );
  vi.spyOn(crypto.subtle, "importKey").mockResolvedValueOnce(otherKey);
  expect(await t.action(internal.deliver.run, { deliveryId: delivery._id })).toMatchObject({
    kind: "permanent",
    error: { code: "WEB_PUSH_INVALID_VAPID_KEY" },
  });
  expect(fetched.mock).not.toHaveBeenCalled();
});

test.each(["configuration", "fingerprint"])(
  "batch continuation records terminal failure after %s changes",
  async (change) => {
    await configureVapid();
    const t = setupTest({ testMode: false });
    const batchId = await t.run((ctx) =>
      ctx.db.insert("batches", {
        userIds: ["alice"],
        vapidPublicKeyHash: "none",
        nextIndex: 0,
        notificationIds: [],
        send: { payload: "x", testMode: false },
        status: "running",
        createdAt: Date.now(),
      }),
    );
    if (change === "configuration") vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
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
  const t = setupTest();
  const { subscription } = await makeSubscription();
  await t.mutation(api.subscriptions.record, { userId: "alice", subscription });
  const notificationId = required(
    await t.mutation(api.notifications.send, { userId: "alice", payload: "private" }),
  );
  expect(await t.query(api.notifications.get, { notificationId, userId: "bob" })).toBeNull();
  expect(
    await t.query(api.deliveries.listForNotification, { notificationId, userId: "bob" }),
  ).toEqual([]);
  expect(await t.query(api.notifications.get, { notificationId, userId: "alice" })).toMatchObject({
    payload: "private",
  });
  expect(
    await t.query(api.deliveries.listForNotification, { notificationId, userId: "alice" }),
  ).toHaveLength(1);
});

test("subscription removal requires an owner", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  const saved = await t.mutation(api.subscriptions.record, { userId: "alice", subscription });
  await expect(
    t.mutation(api.subscriptions.remove, { endpoint: subscription.endpoint } as never),
  ).rejects.toThrow();
  expect(await t.run((ctx) => ctx.db.get("subscriptions", saved.subscriptionId))).not.toBeNull();
});

test.each(["subscription_paused", "ttl_expired", "subscription_expired"])(
  "unsent %s preserves subscription failure health",
  async (reason) => {
    const t = setupTest();
    const { subscription } = await makeSubscription();
    const saved = await t.mutation(api.subscriptions.record, { userId: "alice", subscription });
    const notificationId = required(
      await t.mutation(api.notifications.send, { userId: "alice", payload: "x", ttl: 60 }),
    );
    const delivery = required(
      await t.run((ctx) =>
        ctx.db
          .query("deliveries")
          .withIndex("by_notificationId", (q) => q.eq("notificationId", notificationId))
          .first(),
      ),
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
