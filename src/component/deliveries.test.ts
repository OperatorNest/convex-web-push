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
