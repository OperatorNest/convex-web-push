import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { isWebPushError } from "../shared/errors.js";
import { base64urlEncode } from "../shared/base64url.js";
import { configureVapid, drain, makeSubscription, required, setupTest } from "../test-helpers.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test("registration rejects a 65-byte value outside P-256", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  const point = new Uint8Array(65);
  point[0] = 4;
  await expect(
    t.mutation(api.subscriptions.record, {
      userId: "u",
      subscription: {
        ...subscription,
        keys: { ...subscription.keys, p256dh: base64urlEncode(point) },
      },
    }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_INVALID_SUBSCRIPTION" } });
});
test("registration truncates userAgent without splitting an emoji", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  const result = await t.mutation(api.subscriptions.record, {
    userId: "u",
    subscription,
    userAgent: "a".repeat(255) + "😀",
  });
  const row = required(await t.run((ctx) => ctx.db.get("subscriptions", result.subscriptionId)));
  expect(row.userAgent).toBe("a".repeat(255));
});
test.each(["endpoint", "key", "userId"])("registration bounds %s before storage", async (field) => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  if (field === "endpoint") subscription.endpoint += "a".repeat(10000);
  if (field === "key") subscription.keys.auth += "=".repeat(10000);
  await expect(
    t.mutation(api.subscriptions.record, {
      userId: field === "userId" ? "u".repeat(20000) : "u",
      subscription,
    }),
  ).rejects.toMatchObject({ data: { code: expect.stringMatching(/^WEB_PUSH_/) } });
});
test("batch bounds the supplied array before deduplication", async () => {
  const t = setupTest();
  await expect(
    t.mutation(api.notifications.sendBatch, { userIds: Array(101).fill("u"), payload: "x" }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_BATCH_TOO_LARGE" } });
});
test("raw base64 payload rejects excessive padding before decoding", async () => {
  const t = setupTest();
  await expect(
    t.mutation(api.notifications.send, {
      userId: "u",
      payload: "eA" + "=".repeat(10000),
      payloadEncoding: "base64url",
    }),
  ).rejects.toMatchObject({
    data: { code: "WEB_PUSH_PAYLOAD_TOO_LARGE", message: expect.stringContaining("5324") },
  });
});
test.each(["not-json", "{}", "123", "[{}]", '["u",0,0,"\\ud800"]'])(
  "history rejects malformed cursor %j with a package error",
  async (cursor) => {
    const t = setupTest();
    await expect(
      t.query(api.notifications.listForUser, {
        userId: "u",
        paginationOpts: { numItems: 1, cursor },
      }),
    ).rejects.toMatchObject({ data: { code: "WEB_PUSH_INVALID_ARGUMENT" } });
  },
);
test.each([0, 101, 1.5])("history rejects page size %s", async (numItems) => {
  const t = setupTest();
  await expect(
    t.query(api.notifications.listForUser, {
      userId: "u",
      paginationOpts: { numItems, cursor: null },
    }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_INVALID_ARGUMENT" } });
});
test("endCursor cannot remove the server row budget", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  await t.mutation(api.subscriptions.record, { userId: "u", subscription });
  for (let i = 0; i < 8; i++)
    await t.mutation(api.notifications.send, { userId: "u", payload: "x" });
  const last = await t.query(api.notifications.listForUser, {
    userId: "u",
    paginationOpts: { numItems: 8, cursor: null },
  });
  const page = await t.query(api.notifications.listForUser, {
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
test("an old completion cannot retire a refreshed subscription", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  const saved = await t.mutation(api.subscriptions.record, { userId: "u", subscription });
  const id = required(await t.mutation(api.notifications.send, { userId: "u", payload: "x" }));
  const delivery = required(
    (await t.query(api.deliveries.listForNotification, { notificationId: id, userId: "u" }))[0],
  );
  await t.mutation(internal.deliveries.begin, { deliveryId: delivery._id });
  await t.mutation(api.subscriptions.record, { userId: "u", subscription });
  await t.mutation(internal.deliveries.onComplete, {
    workId: "work" as never,
    context: { deliveryId: delivery._id },
    result: { kind: "success", returnValue: { kind: "gone", errorKind: "subscription_gone" } },
  });
  expect(await t.run((ctx) => ctx.db.get("subscriptions", saved.subscriptionId))).toMatchObject({
    status: "active",
    consecutiveFailures: 0,
  });
});
test("expired subscription pruning consumes the batch budget", async () => {
  const t = setupTest();
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
  const result = await t.mutation(api.notifications.sendBatch, { userIds: users, payload: "x" });
  expect(result.done).toBe(false);
  expect(result.results).toHaveLength(3);
});
test("batch continuation revalidates configuration", async () => {
  await configureVapid();
  const t = setupTest({ testMode: false });
  const { subscription } = await makeSubscription();
  const users = ["a", "b", "c", "d"];
  for (const userId of users)
    for (let i = 0; i < 50; i++)
      await t.mutation(api.subscriptions.record, {
        userId,
        subscription: { ...subscription, endpoint: subscription.endpoint + userId + i },
      });
  const result = await t.mutation(api.notifications.sendBatch, { userIds: users, payload: "x" });
  vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
  await t.mutation(internal.notifications.continueBatch, { batchId: result.batchId });
  expect(await t.query(api.notifications.getBatch, { batchId: result.batchId })).toMatchObject({
    status: "failed",
    errorCode: "WEB_PUSH_NOT_CONFIGURED",
  });
});
test("purge continuations preserve subscriptions recorded after removal began", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  for (let i = 0; i < 101; i++)
    await t.mutation(api.subscriptions.record, {
      userId: "u",
      subscription: { ...subscription, endpoint: subscription.endpoint + i },
    });
  expect((await t.mutation(api.subscriptions.removeAllForUser, { userId: "u" })).done).toBe(false);
  const fresh = await t.mutation(api.subscriptions.record, { userId: "u", subscription });
  await drain(t);
  expect(await t.run((ctx) => ctx.db.get("subscriptions", fresh.subscriptionId))).not.toBeNull();
});
test("cleanup removes a running batch after 35 days", async () => {
  const t = setupTest();
  const batchId = await t.run((ctx) =>
    ctx.db.insert("batches", {
      userIds: [],
      vapidPublicKeyHash: "none",
      nextIndex: 0,
      notificationIds: [],
      send: { payload: "x" },
      status: "running",
      createdAt: Date.now() - 36 * 86400000,
    }),
  );
  await t.mutation(internal.cleanup.run, {});
  expect(await t.run((ctx) => ctx.db.get("batches", batchId))).toBeNull();
});

test("different oversized payloads return the same fixed message", async () => {
  const t = setupTest();
  const data = [];
  for (const size of [3994, 3995]) {
    try {
      await t.mutation(api.notifications.send, { userId: "u", payload: "x".repeat(size) });
    } catch (error) {
      if (isWebPushError(error)) data.push(error.data);
      else throw error;
    }
  }
  expect(data).toHaveLength(2);
  expect(data[0]).toEqual(data[1]);
});

test("removal accepts every Unicode endpoint admitted by registration", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  subscription.endpoint += "é".repeat(3000);
  await t.mutation(api.subscriptions.record, { userId: "u", subscription });
  await expect(
    t.mutation(api.subscriptions.remove, { userId: "u", endpoint: subscription.endpoint }),
  ).resolves.toBe(true);
});
