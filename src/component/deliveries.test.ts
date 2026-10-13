import { afterEach, expect, test, vi, beforeEach } from "vitest";
import { api, internal } from "./_generated/api.js";
import { generateVapidKeys, importVapidPrivateKey } from "../shared/vapid.js";
import {
  configureVapid,
  setupTest,
  makeSubscription,
  required,
  respond,
  stubFetch,
} from "../test-helpers.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("delivery verification passes every cryptographic operation in test mode", async () => {
  const t = setupTest();
  const report = await t.action(api.deliveries.verify, {});
  expect(report.ok).toBe(true);
  expect(report.testMode).toBe(true);
  expect(report.checks.map((c) => c.name)).toEqual([
    "sha256 digest",
    "ECDH P-256 key agreement",
    "RFC 8291 Appendix A vector",
    "VAPID ES256 sign and verify",
  ]);
  expect(report.checks.every((c) => c.ok)).toBe(true);
  expect(report.config).toEqual({
    configured: false,
    problem: "Component configuration is missing, malformed or changed during a batch.",
  });
});

test("delivery verification checks the configured key pair without returning it", async () => {
  const keys = await configureVapid();
  const t = setupTest({ testMode: false });
  const report = await t.action(api.deliveries.verify, {});
  expect(report.ok).toBe(true);
  expect(report.testMode).toBe(false);
  expect(report.config).toEqual({ configured: true });
  expect(report.checks.at(-1)).toEqual({ name: "configured VAPID key pair matches", ok: true });
  expect(JSON.stringify(report)).not.toContain(keys.privateKey);
});

test("delivery verification rejects a mismatched key pair", async () => {
  const a = await generateVapidKeys();
  const b = await generateVapidKeys();
  vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", a.publicKey);
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", b.privateKey);
  vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", "mailto:ops@example.com");
  const t = setupTest();
  const report = await t.action(api.deliveries.verify, {});
  expect(report.ok).toBe(false);
  expect(report.config).toEqual({ configured: true });
  expect(report.checks.at(-1)).toMatchObject({ ok: false, error: expect.any(String) });
  expect(JSON.stringify(report)).not.toContain(b.privateKey);
});

test("delivery verification rejects malformed configuration without returning keys", async () => {
  const keys = await generateVapidKeys();
  vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", keys.publicKey);
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", keys.privateKey);
  vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", "https://localhost");
  const t = setupTest();
  const error: unknown = await t
    .action(api.deliveries.verify, {})
    .catch((caughtError: unknown) => caughtError);
  expect(error).toMatchObject({
    data: {
      code: "WEB_PUSH_NOT_CONFIGURED",
      message: "Component configuration is missing, malformed or changed during a batch.",
    },
  });
  expect(JSON.stringify(error)).not.toContain(keys.privateKey);
});

test("an old completion cannot retire a refreshed subscription", async () => {
  const t = setupTest();
  const { subscription } = await makeSubscription();
  const saved = await t.mutation(api.subscriptions.record, { userId: "u", subscription });
  const id = required(
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "u",
      payload: "x",
    }),
  );
  const delivery = required(
    (await t.query(api.deliveries.list, { notificationId: id, userId: "u" }))[0],
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
  const fetched = stubFetch(respond(201));
  const t = setupTest({ testMode: false });
  const { subscription } = await makeSubscription();
  await t.mutation(api.subscriptions.record, { userId: "alice", subscription });
  const notificationId = required(
    await t.mutation(api.notifications.send, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId: "alice",
      payload: "x",
    }),
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
    error: { code: "WEB_PUSH_NOT_CONFIGURED" },
  });
  expect(fetched.mock).not.toHaveBeenCalled();
});
