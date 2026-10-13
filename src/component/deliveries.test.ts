import { afterEach, expect, test, vi, beforeEach } from "vitest";
import { api, internal } from "./_generated/api.js";
import { generateVapidKeys, importVapidPrivateKey } from "../shared/vapid.js";
import {
  configureVapid,
  makeSubscription,
  required,
  respond,
  setupLiveTest,
  setupSimulatedTest,
  stubFetch,
} from "../test-helpers.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("an old completion cannot retire a refreshed subscription", async () => {
  const t = setupSimulatedTest();
  const { subscription } = await makeSubscription();
  const saved = await t.mutation(api.subscriptions.record, { userId: "u", subscription });
  const id = required(
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u",
      payload: "x",
    }),
    "the notification id",
  );
  const delivery = required(
    (await t.query(api.deliveries.list, { notificationId: id, userId: "u" }))[0],
    "the delivery",
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

test("mismatched VAPID keys fail before any push request", async () => {
  await configureVapid();
  const other = await generateVapidKeys();
  const otherKey = await importVapidPrivateKey(other.publicKey, other.privateKey);
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", other.privateKey);
  const calls = stubFetch(respond(201));
  const t = setupLiveTest();
  const { subscription } = await makeSubscription();
  await t.mutation(api.subscriptions.record, { userId: "alice", subscription });
  const notificationId = required(
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "alice",
      payload: "x",
    }),
    "the notification id",
  );
  const delivery = required(
    await t.run((ctx) =>
      ctx.db
        .query("deliveries")
        .withIndex("by_notificationId", (q) => q.eq("notificationId", notificationId))
        .first(),
    ),
    "the delivery",
  );
  vi.spyOn(crypto.subtle, "importKey").mockResolvedValueOnce(otherKey);
  expect(await t.action(internal.deliver.run, { deliveryId: delivery._id })).toMatchObject({
    kind: "permanent",
    error: { code: "WEB_PUSH_NOT_CONFIGURED" },
  });
  expect(calls).toHaveLength(0);
});

test.each([100, 999, 1000, 1001])(
  "a one-second notification attempted after %s milliseconds respects its deadline",
  async (elapsed) => {
    await configureVapid();
    const calls = stubFetch(respond(201));
    const t = setupLiveTest();
    const { subscription } = await makeSubscription();
    await t.mutation(api.subscriptions.record, { userId: "u", subscription });
    vi.setSystemTime(10_000);
    const notificationId = required(
      await t.mutation(api.notifications.send, {
        userId: "u",
        payload: "x",
        ttlSeconds: 1,
        urgency: "normal",
      }),
      "the notification id",
    );
    const delivery = required(
      (await t.query(api.deliveries.list, { notificationId, userId: "u" }))[0],
      "the delivery",
    );
    vi.setSystemTime(10_000 + elapsed);
    const outcome = await t.action(internal.deliver.run, { deliveryId: delivery._id });
    await t.mutation(internal.deliveries.onComplete, {
      workId: "work" as never,
      context: { deliveryId: delivery._id },
      result: { kind: "success", returnValue: outcome },
    });
    const rows = await t.query(api.deliveries.list, { notificationId, userId: "u" });
    if (elapsed < 1000) {
      expect(calls).toHaveLength(1);
      expect(new Headers(required(calls[0], "the push request").init.headers).get("TTL")).toBe("0");
      expect(rows[0]).toMatchObject({ status: "sent" });
    } else {
      expect(calls).toHaveLength(0);
      expect(rows[0]).toMatchObject({ status: "failed", errorKind: "ttl_expired" });
    }
  },
);

test.each([429, 408, 500, 503, 400, 401, 404, 410, 413, 302, "lost_response"])(
  "delivery errors for %s report retry safety separately from scheduling",
  async (failure) => {
    await configureVapid();
    const calls = stubFetch(() => {
      if (failure === "lost_response") throw new TypeError("response lost after acceptance");
      return new Response(null, { status: Number(failure) });
    });
    const t = setupLiveTest();
    const { subscription } = await makeSubscription();
    await t.mutation(api.subscriptions.record, { userId: "u", subscription });
    const notificationId = required(
      await t.mutation(api.notifications.send, {
        userId: "u",
        payload: "x",
        ttlSeconds: 86400,
        urgency: "normal",
      }),
      "the notification id",
    );
    const delivery = required(
      (await t.query(api.deliveries.list, { notificationId, userId: "u" }))[0],
      "the delivery",
    );
    const outcome = await t.action(internal.deliver.run, { deliveryId: delivery._id });
    await t.mutation(internal.deliveries.onComplete, {
      workId: "work" as never,
      context: { deliveryId: delivery._id },
      result: { kind: "success", returnValue: outcome },
    });
    expect(calls).toHaveLength(1);
    const rows = await t.query(api.deliveries.list, { notificationId, userId: "u" });
    expect(rows[0]?.error).toMatchObject({
      code: failure === "lost_response" ? "WEB_PUSH_NETWORK_ERROR" : "WEB_PUSH_PROVIDER_ERROR",
      retryable: failure === 429,
    });
    expect(rows[0]?.status).toBe(
      failure === "lost_response" || failure === 429 || failure === 408 || Number(failure) >= 500
        ? "retry"
        : failure === 404 || failure === 410
          ? "gone"
          : "failed",
    );
  },
);
