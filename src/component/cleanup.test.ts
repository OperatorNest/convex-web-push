import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { drain, makeSubscription, setupTest, type TestCtx } from "../test-helpers.js";
import { api } from "./_generated/api.js";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 4, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

async function seed(t: TestCtx) {
  const { subscription } = await makeSubscription();
  const { subscriptionId } = await t.mutation(api.subscriptions.record, {
    userId: "u1",
    subscription,
  });
  const notificationId = await t.run((ctx) =>
    ctx.db.insert("notifications", {
      userId: "u1",
      payload: "x",
      options: { ttl: 60, urgency: "normal" },
      status: "delivered",
      counts: { queued: 0, sent: 1, failed: 0, gone: 0 },
      createdAt: now,
    }),
  );
  return { subscriptionId, notificationId };
}

async function addDelivery(
  t: TestCtx,
  ids: { subscriptionId: Id<"subscriptions">; notificationId: Id<"notifications"> },
  status: "sent" | "queued" | "retry",
  ageDays: number,
) {
  return t.run((ctx) =>
    ctx.db.insert("deliveries", {
      ...ids,
      userId: "u1",
      status,
      attempts: 1,
      createdAt: now - ageDays * DAY,
    }),
  );
}

test("deletes finished deliveries past retention and keeps recent and unfinished ones", async () => {
  const t = setupTest();
  const ids = await seed(t);
  const old = await addDelivery(t, ids, "sent", 8);
  const recent = await addDelivery(t, ids, "sent", 1);
  const retrying = await addDelivery(t, ids, "retry", 10);
  const stuck = await addDelivery(t, ids, "queued", 40);

  const result = await t.mutation(internal.cleanup.run, { now });
  expect(result).toEqual({ deleted: 2, more: false });
  const exists = (id: Id<"deliveries">) => t.run((ctx) => ctx.db.get("deliveries", id));
  expect(await exists(old)).toBeNull();
  expect(await exists(stuck)).toBeNull();
  expect(await exists(recent)).not.toBeNull();
  expect(await exists(retrying)).not.toBeNull();
});

test("deletes finished notifications past retention but keeps unfinished ones", async () => {
  const t = setupTest();
  const { notificationId } = await seed(t);
  const insert = (status: "delivered" | "failed" | "queued" | "partial", ageDays: number) =>
    t.run((ctx) =>
      ctx.db.insert("notifications", {
        userId: "u1",
        payload: "x",
        options: { ttl: 60, urgency: "normal" },
        status,
        counts: {
          queued: status === "queued" || status === "partial" ? 1 : 0,
          sent: 0,
          failed: 0,
          gone: 0,
        },
        createdAt: now - ageDays * DAY,
      }),
    );
  const oldDelivered = await insert("delivered", 9);
  const oldFailed = await insert("failed", 9);
  const pending = await insert("queued", 15);
  const stuck = await insert("partial", 40);
  await t.mutation(internal.cleanup.run, { now });
  const get = (id: Id<"notifications">) => t.run((ctx) => ctx.db.get("notifications", id));
  expect(await get(oldDelivered)).toBeNull();
  expect(await get(oldFailed)).toBeNull();
  expect(await get(stuck)).toBeNull();
  expect(await get(pending)).not.toBeNull();
  expect(await get(notificationId)).not.toBeNull();
});

test("deletes gone subscriptions after a week", async () => {
  const t = setupTest();
  const { subscriptionId } = await seed(t);
  await t.run((ctx) =>
    ctx.db.patch("subscriptions", subscriptionId, { status: "gone", updatedAt: now - 8 * DAY }),
  );
  await t.mutation(internal.cleanup.run, { now });
  expect(await t.run((ctx) => ctx.db.get("subscriptions", subscriptionId))).toBeNull();

  const fresh = await seed(t);
  await t.run((ctx) =>
    ctx.db.patch("subscriptions", fresh.subscriptionId, { status: "gone", updatedAt: now - DAY }),
  );
  await t.mutation(internal.cleanup.run, { now });
  expect(await t.run((ctx) => ctx.db.get("subscriptions", fresh.subscriptionId))).not.toBeNull();
});

test("caps the combined delete count per transaction and continues later", async () => {
  const t = setupTest();
  const ids = await seed(t);
  for (let i = 0; i < 600; i++) await addDelivery(t, ids, "sent", 9);
  const first = await t.mutation(internal.cleanup.run, { now });
  expect(first).toEqual({ deleted: 500, more: true });
  await drain(t);
  const left = await t.run((ctx) =>
    ctx.db
      .query("deliveries")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "sent"))
      .take(700),
  );
  expect(left).toHaveLength(0);
});

test("removes finished batch records after retention", async () => {
  const t = setupTest();
  const insert = (status: "done" | "running", ageDays: number) =>
    t.run((ctx) =>
      ctx.db.insert("batches", {
        userIds: [],
        nextIndex: 0,
        notificationIds: [],
        send: { payload: "x" },
        status,
        createdAt: now - ageDays * DAY,
      }),
    );
  const oldDone = await insert("done", 9);
  const running = await insert("running", 9);
  await t.mutation(internal.cleanup.run, { now });
  expect(await t.run((ctx) => ctx.db.get("batches", oldDone))).toBeNull();
  expect(await t.run((ctx) => ctx.db.get("batches", running))).not.toBeNull();
});
