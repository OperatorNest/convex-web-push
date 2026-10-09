import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import {
  configureVapid,
  drain,
  makeSubscription,
  required,
  setupTest,
  type TestCtx,
} from "../test-helpers.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function subscribe(t: TestCtx, userId: string) {
  const sub = await makeSubscription();
  await t.mutation(api.subscriptions.record, { userId, subscription: sub.subscription });
  return sub;
}

const liveCount = async (t: TestCtx, userId: string) => {
  const s = await t.query(api.subscriptions.statusForUser, { userId });
  return s.subscriptions + s.paused;
};

test("records a subscription and upserts by endpoint", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription("updates.push.services.mozilla.com");
  const first = await t.mutation(api.subscriptions.record, {
    userId: "u1",
    subscription,
    userAgent: "Firefox",
  });
  expect(first.created).toBe(true);
  const again = await t.mutation(api.subscriptions.record, { userId: "u1", subscription });
  expect(again).toEqual({ subscriptionId: first.subscriptionId, created: false });
  const rows = await t.run((ctx) => ctx.db.query("subscriptions").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    service: "mozilla",
    status: "active",
    vapidPublicKeyHash: "none",
    endpointHash: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
});

test("fingerprints the configured VAPID public key", async () => {
  const keys = await configureVapid();
  const t = setupTest({ testMode: false });
  const { subscription } = await makeSubscription();
  await t.mutation(api.subscriptions.record, { userId: "u1", subscription });
  const row = await t.run((ctx) => ctx.db.query("subscriptions").first());
  expect(row?.vapidPublicKeyHash).toMatch(/^[0-9a-f]{16}$/);
  expect(JSON.stringify(row)).not.toContain(keys.privateKey);
});

test("reassigns an endpoint that moves to another user", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  await t.mutation(api.subscriptions.record, { userId: "alice", subscription });
  await t.mutation(api.subscriptions.record, { userId: "bob", subscription });
  expect((await t.query(api.subscriptions.statusForUser, { userId: "alice" })).subscriptions).toBe(
    0,
  );
  expect((await t.query(api.subscriptions.statusForUser, { userId: "bob" })).subscriptions).toBe(1);
});

test("rejects malformed subscriptions and disallowed endpoints", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  const record = (patch: object) =>
    t.mutation(api.subscriptions.record, {
      userId: "u1",
      subscription: { ...subscription, ...patch },
    });
  await expect(record({ endpoint: "https://evil.example.com/x" })).rejects.toMatchObject({
    data: { code: "WEB_PUSH_INVALID_SUBSCRIPTION" },
  });
  await expect(record({ endpoint: "http://fcm.googleapis.com/x" })).rejects.toMatchObject({
    data: { code: "WEB_PUSH_INVALID_SUBSCRIPTION" },
  });
  await expect(record({ keys: { ...subscription.keys, p256dh: "AAAA" } })).rejects.toMatchObject({
    data: { code: "WEB_PUSH_INVALID_SUBSCRIPTION" },
  });
  await expect(record({ keys: { ...subscription.keys, auth: "AAAA" } })).rejects.toMatchObject({
    data: { code: "WEB_PUSH_INVALID_SUBSCRIPTION" },
  });
  await expect(record({ keys: { ...subscription.keys, auth: "***" } })).rejects.toMatchObject({
    data: { code: "WEB_PUSH_INVALID_SUBSCRIPTION" },
  });
  expect(await t.run((ctx) => ctx.db.query("subscriptions").collect())).toHaveLength(0);
});

test("allowedPushHosts extends the endpoint allowlist", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription("push.example.test");
  await expect(
    t.mutation(api.subscriptions.record, { userId: "u1", subscription }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_INVALID_SUBSCRIPTION" } });
  await expect(
    t.mutation(api.subscriptions.record, {
      userId: "u1",
      subscription,
      allowedPushHosts: ["push.example.test"],
    }),
  ).resolves.toMatchObject({ created: true });
});

test("remove deletes by endpoint and reports whether it existed", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  await t.mutation(api.subscriptions.record, { userId: "u1", subscription });
  expect(await t.mutation(api.subscriptions.remove, { endpoint: subscription.endpoint })).toBe(
    true,
  );
  expect(await t.mutation(api.subscriptions.remove, { endpoint: subscription.endpoint })).toBe(
    false,
  );
});

test("removeAllForUser removes every subscription of that user only", async () => {
  const t = setupTest();
  for (const userId of ["u1", "u1", "u2"]) {
    const { subscription } = await makeSubscription();
    await t.mutation(api.subscriptions.record, { userId, subscription });
  }
  expect(await t.mutation(api.subscriptions.removeAllForUser, { userId: "u1" })).toEqual({
    removed: 2,
    done: true,
  });
  expect((await t.query(api.subscriptions.statusForUser, { userId: "u2" })).subscriptions).toBe(1);
});

test("pause and resume move subscriptions between states", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  await t.mutation(api.subscriptions.record, { userId: "u1", subscription });
  expect(await t.mutation(api.subscriptions.pauseForUser, { userId: "u1" })).toBe(1);
  expect(await t.query(api.subscriptions.statusForUser, { userId: "u1" })).toMatchObject({
    subscriptions: 0,
    paused: 1,
  });
  // Re-recording a paused subscription of the same user keeps the pause.
  await t.mutation(api.subscriptions.record, { userId: "u1", subscription });
  expect((await t.query(api.subscriptions.statusForUser, { userId: "u1" })).paused).toBe(1);
  expect(await t.mutation(api.subscriptions.resumeForUser, { userId: "u1" })).toBe(1);
  expect((await t.query(api.subscriptions.statusForUser, { userId: "u1" })).subscriptions).toBe(1);
});

test("re-recording a gone subscription reactivates it", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  const { subscriptionId } = await t.mutation(api.subscriptions.record, {
    userId: "u1",
    subscription,
  });
  await t.run((ctx) =>
    ctx.db.patch("subscriptions", subscriptionId, { status: "gone", consecutiveFailures: 4 }),
  );
  await t.mutation(api.subscriptions.record, { userId: "u1", subscription });
  const row = await t.run((ctx) => ctx.db.get("subscriptions", subscriptionId));
  expect(row).toMatchObject({ status: "active", consecutiveFailures: 0 });
});

test("keeps at most 50 live subscriptions per user by retiring the oldest", async () => {
  const t = setupTest();
  const endpoints: string[] = [];
  for (let i = 0; i < 51; i++) {
    const { subscription } = await makeSubscription();
    endpoints.push(subscription.endpoint);
    await t.mutation(api.subscriptions.record, { userId: "u1", subscription });
  }
  expect((await t.query(api.subscriptions.statusForUser, { userId: "u1" })).subscriptions).toBe(50);
  const oldest = await t.run((ctx) =>
    ctx.db
      .query("subscriptions")
      .withIndex("by_status_updatedAt", (q) => q.eq("status", "gone"))
      .take(5),
  );
  expect(oldest).toHaveLength(1);
  expect(required(oldest[0]).endpoint).toBe(endpoints[0]);
});

test("getPublicKey returns the configured public key only", async () => {
  const t = setupTest({ testMode: false });
  expect(await t.query(api.config.getPublicKey, {})).toBeNull();
  const keys = await configureVapid();
  expect(await t.query(api.config.getPublicKey, {})).toBe(keys.publicKey);
});

test("re-recording a gone endpoint respects the subscription cap", async () => {
  const t = setupTest();
  const first = await makeSubscription();
  await t.mutation(api.subscriptions.record, { userId: "u1", subscription: first.subscription });
  for (let i = 0; i < 50; i++) await subscribe(t, "u1");
  expect(await liveCount(t, "u1")).toBe(50);
  await t.mutation(api.subscriptions.record, { userId: "u1", subscription: first.subscription });
  expect(await liveCount(t, "u1")).toBe(50);
});

test("paused subscriptions count toward the cap", async () => {
  const t = setupTest();
  for (let i = 0; i < 50; i++) await subscribe(t, "u1");
  await t.mutation(api.subscriptions.pauseForUser, { userId: "u1" });
  await subscribe(t, "u1");
  expect(await liveCount(t, "u1")).toBe(50);
});

test("an endpoint moving to a user at the cap does not exceed it", async () => {
  const t = setupTest();
  for (let i = 0; i < 50; i++) await subscribe(t, "bob");
  const alice = await subscribe(t, "alice");
  await t.mutation(api.subscriptions.record, { userId: "bob", subscription: alice.subscription });
  expect(await liveCount(t, "bob")).toBe(50);
});

test("removeAllForUser removes more than one batch through scheduled continuations", async () => {
  const t = setupTest();
  for (let i = 0; i < 151; i++) await subscribe(t, "u1");
  await subscribe(t, "other");
  const first = await t.mutation(api.subscriptions.removeAllForUser, { userId: "u1" });
  expect(first).toEqual({ removed: 100, done: false });
  await drain(t);
  const rows = await t.run((ctx) => ctx.db.query("subscriptions").collect());
  expect(rows.map((r) => r.userId)).toEqual(["other"]);
});

test("remove with a userId only removes that user's subscription", async () => {
  const t = setupTest();
  const { subscription } = await subscribe(t, "alice");
  expect(
    await t.mutation(api.subscriptions.remove, { endpoint: subscription.endpoint, userId: "bob" }),
  ).toBe(false);
  expect(await liveCount(t, "alice")).toBe(1);
  expect(
    await t.mutation(api.subscriptions.remove, {
      endpoint: subscription.endpoint,
      userId: "alice",
    }),
  ).toBe(true);
});

test("re-subscribing replaces the expiration and user agent", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  await t.mutation(api.subscriptions.record, {
    userId: "u1",
    subscription: { ...subscription, expirationTime: Date.now() + 60_000 },
    userAgent: "Old".repeat(200),
  });
  const row = required(await t.run((ctx) => ctx.db.query("subscriptions").first()));
  expect(row.expirationTime).toBeTypeOf("number");
  expect(row.userAgent).toHaveLength(256);
  await t.mutation(api.subscriptions.record, { userId: "u1", subscription });
  const updated = required(await t.run((ctx) => ctx.db.get("subscriptions", row._id)));
  expect(updated.expirationTime).toBeUndefined();
  expect(updated.userAgent).toBeUndefined();
});
