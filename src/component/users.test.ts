import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
  type TestCtx,
  configureVapid,
  drain,
  expectWebPushError,
  makeSubscription,
  required,
  setupLiveTest,
  setupSimulatedTest,
} from "../test-helpers.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function subscribe(t: TestCtx, userId: string, testMode?: boolean) {
  const { subscription } = await makeSubscription();
  await t.mutation(api.subscriptions.record, { userId, subscription, testMode });
  return subscription;
}

const send = (t: TestCtx, userId: string, testMode?: boolean) =>
  t.mutation(api.notifications.send, {
    ttlSeconds: 86400,
    urgency: "normal",
    userId,
    payload: "x",
    testMode,
  });

const rowsOf = (t: TestCtx, userId: string) =>
  t.run(async (ctx) => {
    const owners = await ctx.db.query("subscriptionOwners").take(1000);
    const subscriptions = await ctx.db.query("subscriptions").take(1000);
    const notifications = await ctx.db.query("notifications").take(1000);
    const deliveries = await ctx.db.query("deliveries").take(1000);
    return [owners, subscriptions, notifications, deliveries].map(
      (rows) => rows.filter((row) => row.userId === userId).length,
    );
  });

test("purge deletes the user's subscriptions, notifications, deliveries and owner row", async () => {
  const t = setupSimulatedTest();
  await subscribe(t, "alice");
  await subscribe(t, "alice");
  await subscribe(t, "bob");
  await send(t, "alice");
  await send(t, "bob");
  await drain(t);
  expect(await rowsOf(t, "alice")).toEqual([1, 2, 1, 2]);

  expect(await t.mutation(api.users.purge, { userId: "alice" })).toEqual({
    removed: 5,
    done: true,
  });
  expect(await rowsOf(t, "alice")).toEqual([0, 0, 0, 0]);
  expect(await rowsOf(t, "bob")).toEqual([1, 1, 1, 1]);
});

test("purge leaves the user's rows in the other test mode", async () => {
  await configureVapid();
  const t = setupLiveTest();
  await subscribe(t, "alice", true);
  await subscribe(t, "alice", false);
  await send(t, "alice", true);
  await t.mutation(api.users.purge, { userId: "alice", testMode: true });
  const left = await t.run(async (ctx) => ({
    subscriptions: await ctx.db.query("subscriptions").take(10),
    owners: await ctx.db.query("subscriptionOwners").take(10),
    notifications: await ctx.db.query("notifications").take(10),
  }));
  expect(left.subscriptions.map((row) => row.testMode)).toEqual([false]);
  expect(left.owners.map((row) => row.testMode)).toEqual([false]);
  expect(left.notifications).toEqual([]);
});

test("purge continues in scheduled steps of at most 100 rows", async () => {
  const t = setupSimulatedTest();
  for (let i = 0; i < 50; i++) await subscribe(t, "alice");
  await send(t, "alice");
  await send(t, "alice");
  await drain(t);
  expect(await rowsOf(t, "alice")).toEqual([1, 50, 2, 100]);
  const first = await t.mutation(api.users.purge, { userId: "alice" });
  expect(first).toEqual({ removed: 100, done: false });
  await drain(t);
  expect(await rowsOf(t, "alice")).toEqual([0, 0, 0, 0]);
});

test("purge keeps registrations and notifications created after it began", async () => {
  const t = setupSimulatedTest();
  for (let i = 0; i < 101; i++) await subscribe(t, "alice");
  expect((await t.mutation(api.users.purge, { userId: "alice" })).done).toBe(false);
  vi.setSystemTime(Date.now() + 1000);
  const fresh = await subscribe(t, "alice");
  const notificationId = required(await send(t, "alice"), "the later notification");
  await drain(t);
  const left = await t.run(async (ctx) => ({
    subscriptions: await ctx.db.query("subscriptions").take(10),
    owners: await ctx.db.query("subscriptionOwners").take(10),
    notification: await ctx.db.get("notifications", notificationId),
  }));
  expect(left.subscriptions.map((row) => row.endpoint)).toEqual([fresh.endpoint]);
  expect(left.owners).toHaveLength(1);
  expect(left.notification).not.toBeNull();
});

test("a removal pending before a purge cannot delete registrations recorded after it", async () => {
  const t = setupSimulatedTest();
  for (let i = 0; i < 101; i++) await subscribe(t, "alice");
  expect((await t.mutation(api.subscriptions.removeAll, { userId: "alice" })).done).toBe(false);
  await t.mutation(api.users.purge, { userId: "alice" });
  await t.mutation(api.users.purge, { userId: "alice" });
  expect(await t.run((ctx) => ctx.db.query("subscriptionOwners").take(10))).toEqual([]);
  const fresh = await subscribe(t, "alice");
  await drain(t);
  const left = await t.run((ctx) => ctx.db.query("subscriptions").take(10));
  expect(left.map((row) => row.endpoint)).toEqual([fresh.endpoint]);
});

test("a purge continuation skips subscriptions once its generation was reset", async () => {
  const t = setupSimulatedTest();
  await subscribe(t, "alice");
  const before = Date.now();
  await t.mutation(internal.users.continuePurge, {
    userId: "alice",
    testMode: true,
    generation: 5,
    before,
  });
  expect(await rowsOf(t, "alice")).toEqual([1, 1, 0, 0]);
});

test("purge of an unknown user removes nothing and creates no owner row", async () => {
  const t = setupSimulatedTest();
  expect(await t.mutation(api.users.purge, { userId: "nobody" })).toEqual({
    removed: 0,
    done: true,
  });
  expect(await t.run((ctx) => ctx.db.query("subscriptionOwners").take(10))).toEqual([]);
  await expectWebPushError(
    t.mutation(api.users.purge, { userId: "" }),
    "WEB_PUSH_INVALID_ARGUMENT",
  );
});

test("a delivery in flight when its user is purged ends without restoring rows", async () => {
  const t = setupSimulatedTest();
  await subscribe(t, "alice");
  await send(t, "alice");
  await t.mutation(api.users.purge, { userId: "alice" });
  await drain(t);
  expect(await rowsOf(t, "alice")).toEqual([0, 0, 0, 0]);
});
