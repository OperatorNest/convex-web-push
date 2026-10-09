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
  await t.mutation(internal.admin.saveSubscription, { userId, subscription });
  return subscription;
}

test("record, notify and the onComplete callback work through the client", async () => {
  const t = setup();
  const { subscription } = await makeSubscription();
  const saved = await t.mutation(internal.admin.saveSubscription, { userId: "u1", subscription });
  expect(saved.created).toBe(true);

  const id = await t.mutation(internal.admin.notify, {
    userId: "u1",
    title: "Hello",
    body: "World",
    url: "/inbox",
  });
  expect(id).not.toBeNull();
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const page = await t.query(internal.admin.notifications, {
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

  const results = await t.run((ctx) => ctx.db.query("notificationResults").collect());
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
  const a = await t.mutation(internal.admin.notify, {
    userId: "u1",
    title: "x",
    idempotencyKey: "order-1",
  });
  const b = await t.mutation(internal.admin.notify, {
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
  const { results, done } = await t.mutation(internal.admin.broadcast, {
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
  const error = await t.mutation(internal.admin.notify, { userId: "u1", title: "x" }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isWebPushError(error)).toBe(true);
  if (isWebPushError(error)) expect(error.data.code).toBe("WEB_PUSH_NOT_CONFIGURED");
  expect(await t.query(api.example.publicKey, {})).toBeNull();
});

test("a client created with testMode: true records without env opt-in", async () => {
  const t = setup();
  await saveSubscription(t, "u1");
  vi.stubEnv("WEB_PUSH_TEST_MODE", undefined);
  const id = await t.mutation(internal.admin.notifyInTestMode, { userId: "u1", title: "x" });
  expect(id).not.toBeNull();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const page = await t.query(internal.admin.notifications, {
    userId: "u1",
    paginationOpts: { numItems: 5, cursor: null },
  });
  expect(page.page[0]).toMatchObject({ status: "delivered", testMode: true });
});

test("public functions need a signed-in user and only act on that user", async () => {
  const t = setup();
  const { subscription } = await makeSubscription();
  await expect(t.mutation(api.example.saveSubscription, { subscription })).rejects.toThrow(
    /Not signed in/,
  );
  await expect(t.mutation(api.example.notifyMe, { title: "x" })).rejects.toThrow(/Not signed in/);

  const alice = t.withIdentity({ subject: "alice" });
  const bob = t.withIdentity({ subject: "bob" });
  await alice.mutation(api.example.saveSubscription, { subscription });
  expect(await alice.query(api.example.myStatus, {})).toMatchObject({ subscriptions: 1 });
  expect(await bob.query(api.example.myStatus, {})).toMatchObject({ subscriptions: 0 });

  // Bob cannot remove Alice's subscription even with her endpoint.
  expect(
    await bob.mutation(api.example.removeSubscription, { endpoint: subscription.endpoint }),
  ).toBe(false);
  expect(await alice.mutation(api.example.pauseMine, {})).toBe(1);
  expect(await alice.mutation(api.example.notifyMe, { title: "x" })).toBeNull();
  expect(await alice.mutation(api.example.resumeMine, {})).toBe(1);
  const id = await alice.mutation(api.example.notifyMe, { title: "to me" });
  expect(id).not.toBeNull();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const mine = await alice.query(api.example.myNotifications, {
    paginationOpts: { numItems: 5, cursor: null },
  });
  expect(mine.page).toHaveLength(1);
  expect(
    (
      await bob.query(api.example.myNotifications, {
        paginationOpts: { numItems: 5, cursor: null },
      })
    ).page,
  ).toEqual([]);
});

test("sending to other users or broadcasting is not part of the public API", () => {
  // The public `api` has no `admin` module or `notify`/`broadcast`: these lines fail to compile
  // if one of them is ever made public.
  // @ts-expect-error -- admin functions are internal
  expect(api.admin).toBeDefined();
  // @ts-expect-error -- notify (any userId) is internal
  expect(api.example.notify).toBeDefined();
  // @ts-expect-error -- broadcast is internal
  expect(api.example.broadcast).toBeDefined();
});
