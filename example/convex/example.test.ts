import { register } from "@operatornest/convex-web-push/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isWebPushError } from "../../src/shared/errors.js";
import { makeSubscription } from "../../src/test-helpers.js";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

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

async function saveSubscription(t: ReturnType<typeof setup>, userId: string) {
  const { subscription } = await makeSubscription();
  await t.mutation(internal.admin.recordSubscription, { userId, subscription });
  return subscription;
}

test("record, notify and the onComplete callback work through the client", async () => {
  const t = setup();
  const { subscription } = await makeSubscription();
  const saved = await t.mutation(internal.admin.recordSubscription, { userId: "u1", subscription });
  expect(saved.created).toBe(true);

  const id = await t.mutation(internal.admin.sendNotification, {
    userId: "u1",
    title: "Hello",
    body: "World",
    url: "/inbox",
  });
  expect(id).not.toBeNull();
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const page = await t.query(internal.admin.listNotifications, {
    userId: "u1",
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(page.page).toHaveLength(1);
  expect(JSON.parse(page.page[0]?.payload ?? "null")).toEqual({
    title: "Hello",
    body: "World",
    url: "/inbox",
  });
  expect(page.page[0]).toMatchObject({ status: "delivered", counts: { sent: 1 } });

  const results = await t.run((ctx) => ctx.db.query("notificationResults").take(10000));
  expect(results).toEqual([
    expect.objectContaining({
      notificationId: id,
      userId: "u1",
      status: "delivered",
      sent: 1,
      failed: 0,
      gone: 0,
    }),
  ]);
});

test("idempotencyKey makes repeated notify calls a no-op", async () => {
  const t = setup();
  await saveSubscription(t, "u1");
  const a = await t.mutation(internal.admin.sendNotification, {
    userId: "u1",
    title: "x",
    idempotencyKey: "order-1",
  });
  const b = await t.mutation(internal.admin.sendNotification, {
    userId: "u1",
    title: "x",
    idempotencyKey: "order-1",
  });
  expect(b).toBe(a);
});

test("a broadcast reaches every user with a subscription", async () => {
  const t = setup();
  await saveSubscription(t, "a");
  await saveSubscription(t, "b");
  const { results, done } = await t.mutation(internal.admin.sendBatch, {
    userIds: ["a", "b", "nobody"],
    title: "News",
  });
  expect(done).toBe(true);
  expect(results.map((r) => r.notificationId !== null)).toEqual([true, true, false]);
});

test("without opt-in, notify fails with a typed configuration error", async () => {
  const t = setup();
  await saveSubscription(t, "u1");
  vi.stubEnv("WEB_PUSH_TEST_MODE", undefined);
  const error = await t
    .mutation(internal.admin.sendNotification, { userId: "u1", title: "x" })
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  expect(isWebPushError(error)).toBe(true);
  if (isWebPushError(error)) expect(error.data.code).toBe("WEB_PUSH_INVALID_ARGUMENT");
  await expect(
    t.withIdentity({ subject: "reader" }).query(api.example.applicationServerKey, {}),
  ).rejects.toThrow();
});

test("a client created with testMode: true records without env opt-in", async () => {
  const t = setup();
  await saveSubscription(t, "u1");
  vi.stubEnv("WEB_PUSH_TEST_MODE", undefined);
  const id = await t.mutation(internal.admin.sendTestNotification, { userId: "u1", title: "x" });
  expect(id).not.toBeNull();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.stubEnv("WEB_PUSH_TEST_MODE", "true");
  const page = await t.query(internal.admin.listNotifications, {
    userId: "u1",
    paginationOpts: { numItems: 5, cursor: null },
  });
  expect(page.page[0]).toMatchObject({ status: "delivered", testMode: true });
});

test("public functions need a signed-in user and only act on that user", async () => {
  const t = setup();
  const { subscription } = await makeSubscription();
  await expect(t.mutation(api.example.recordSubscription, { subscription })).rejects.toThrow(
    /Not signed in/,
  );
  await expect(t.mutation(api.example.notifyMe, { title: "x" })).rejects.toThrow(/Not signed in/);

  const alice = t.withIdentity({ subject: "alice" });
  const bob = t.withIdentity({ subject: "bob" });
  await alice.mutation(api.example.recordSubscription, { subscription });
  expect(await alice.query(api.example.getMySubscriptionStatus, {})).toMatchObject({
    subscriptions: 1,
  });
  expect(await bob.query(api.example.getMySubscriptionStatus, {})).toMatchObject({
    subscriptions: 0,
  });

  expect(
    await bob.mutation(api.example.removeSubscription, { endpoint: subscription.endpoint }),
  ).toBe(false);
  expect(await alice.mutation(api.example.pauseMySubscriptions, {})).toBe(1);
  expect(await alice.mutation(api.example.notifyMe, { title: "x" })).toBeNull();
  expect(await alice.mutation(api.example.resumeMySubscriptions, {})).toBe(1);
  const id = await alice.mutation(api.example.notifyMe, { title: "to me" });
  expect(id).not.toBeNull();
  const notificationId = id ?? "missing";
  await expect(bob.query(api.example.getMyNotification, { notificationId })).rejects.toThrow();
  await expect(bob.query(api.example.listMyDeliveries, { notificationId })).rejects.toThrow();
  expect(await alice.query(api.example.getMyNotification, { notificationId })).toMatchObject({
    status: "queued",
  });
  expect(await alice.query(api.example.listMyDeliveries, { notificationId })).toHaveLength(1);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const mine = await alice.query(api.example.listMyNotifications, {
    paginationOpts: { numItems: 5, cursor: null },
  });
  expect(mine.page).toHaveLength(1);
  expect(
    (
      await bob.query(api.example.listMyNotifications, {
        paginationOpts: { numItems: 5, cursor: null },
      })
    ).page,
  ).toEqual([]);
});

test("sending to other users or broadcasting is not part of the public API", () => {
  // @ts-expect-error -- admin functions are internal
  expect(api.admin).toBeDefined();
  // @ts-expect-error -- notify (any userId) is internal
  expect(api.example.notify).toBeDefined();
  // @ts-expect-error -- broadcast is internal
  expect(api.example.broadcast).toBeDefined();
});

test("equal subjects from different issuers own different subscriptions", async () => {
  const t = setup();
  const { subscription } = await makeSubscription();
  const alice = t.withIdentity({
    subject: "123",
    issuer: "https://a.example.com",
    tokenIdentifier: "https://a.example.com|123",
  });
  const bob = t.withIdentity({
    subject: "123",
    issuer: "https://b.example.com",
    tokenIdentifier: "https://b.example.com|123",
  });
  await alice.mutation(api.example.recordSubscription, { subscription });
  expect(await bob.query(api.example.getMySubscriptionStatus, {})).toMatchObject({
    subscriptions: 0,
  });
  expect(
    await bob.mutation(api.example.removeSubscription, { endpoint: subscription.endpoint }),
  ).toBe(false);
});
