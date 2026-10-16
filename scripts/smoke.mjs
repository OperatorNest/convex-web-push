import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { assertSmoke, errorCodeOf, runSmoke, smokeEnv, step, waitFor } from "./smoke-harness.mjs";

const root = resolve(import.meta.dirname, "..");
const api = anyApi;
const VAPID_ENV_NAMES = [
  "WEB_PUSH_VAPID_PRIVATE_KEY",
  "WEB_PUSH_VAPID_PUBLIC_KEY",
  "WEB_PUSH_VAPID_SUBJECT",
];
const BROADCAST_USERS = 80;
const PER_USER_SUBSCRIPTIONS = 2;

function canonical(value) {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function assertEqual(actual, expected, what) {
  assertSmoke(
    canonical(actual) === canonical(expected),
    `${what}: expected ${canonical(expected)}, got ${canonical(actual)}`,
  );
}

const ADMIN_QUERIES = new Set([
  "getBatch",
  "getNotification",
  "getSubscription",
  "getSubscriptionStatus",
  "listDeliveries",
  "listNotificationResults",
  "listNotifications",
]);
const ADMIN_ACTIONS = new Set(["verifyConfig"]);

function callWith(client) {
  return (name, args = {}) => {
    const reference = anyApi.admin[name];
    if (ADMIN_QUERIES.has(name)) return client.query(reference, args);
    if (ADMIN_ACTIONS.has(name)) return client.action(reference, args);
    return client.mutation(reference, args);
  };
}

function generateKeys() {
  const out = execFileSync(
    process.execPath,
    [join(root, "bin/convex-web-push.js"), "generate-keys", "--subject", "mailto:smoke@acme.dev"],
    { encoding: "utf8", env: smokeEnv },
  );
  const entries = out
    .split("\n")
    .filter((line) => /^WEB_PUSH_VAPID_[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
  assertEqual(entries.map(([name]) => name).toSorted(), VAPID_ENV_NAMES, "CLI env lines");
  return Object.fromEntries(entries);
}

async function fakeSubscription() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const p256dh = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/smoke-${crypto.randomUUID()}`,
    expirationTime: null,
    keys: {
      p256dh: p256dh.toString("base64url"),
      auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
    },
  };
}

async function inChunks(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

async function errorCode(promise) {
  try {
    await promise;
  } catch (error) {
    return errorCodeOf(error) ?? `no code (${String(error?.message).slice(0, 120)})`;
  }
  return "no error";
}

await runSmoke(async (backend) => {
  const run = crypto.randomUUID().slice(0, 8);
  const user = `smoke-${run}`;
  const call = callWith(backend.client);
  const notification = (args) => call("sendNotification", { userId: user, ...args });
  const page = (cursor, numItems) =>
    call("listNotifications", { userId: user, paginationOpts: { numItems, cursor } });
  const detail = (notificationId, userId) => call("getNotification", { notificationId, userId });
  const settled = (notificationId, userId) =>
    waitFor(async () => {
      const found = await detail(notificationId, userId);
      return found && ["delivered", "failed"].includes(found.status) ? found : null;
    });

  const keys = generateKeys();
  for (const [name, value] of Object.entries({ ...keys, WEB_PUSH_TEST_MODE: "true" }))
    await backend.setEnvironmentVariable(name, value);

  await step(
    "config.verify passes every WebCrypto operation and config.get returns the configured key",
    async () => {
      const report = await waitFor(async () => {
        const result = await call("verifyConfig", {});
        return result.config.configured && result.testMode ? result : null;
      });
      assertSmoke(report.ok === true, `verifyConfig failed: ${JSON.stringify(report.checks)}`);
      assertSmoke(
        report.checks.some((c) => c.name === "RFC 8291 Appendix A vector" && c.ok),
        "the RFC 8291 vector check did not pass",
      );
      assertEqual(
        await backend.runFunction("config:get", {}, { component: "webPush" }),
        { applicationServerKey: keys.WEB_PUSH_VAPID_PUBLIC_KEY },
        "config.get",
      );
    },
  );

  const subscription = await fakeSubscription();
  await step("recordSubscription stores a subscription and rejects a bad endpoint", async () => {
    const saved = await call("recordSubscription", {
      userId: user,
      subscription,
    });
    assertSmoke(saved.created === true, "the subscription was not created");
    const evil = { ...(await fakeSubscription()), endpoint: "https://evil.example.com/push" };
    const code = await errorCode(call("recordSubscription", { userId: user, subscription: evil }));
    assertEqual(code, "WEB_PUSH_INVALID_ARGUMENT", "error code for a disallowed endpoint");
  });

  await step("the public functions reject a caller who is not signed in", async () => {
    const client = new ConvexHttpClient(backend.url, { logger: false });
    const mutation = client.mutation(api.example.notifyMe, { title: "nope" });
    const message = await mutation.then(
      () => "no error",
      (error) => String(error?.message),
    );
    assertSmoke(
      /Not signed in/.test(message),
      `expected Not signed in, got ${message.slice(0, 120)}`,
    );
    const save = await client
      .mutation(api.example.recordSubscription, { subscription: await fakeSubscription() })
      .then(
        () => "no error",
        (error) => String(error?.message),
      );
    assertSmoke(/Not signed in/.test(save), `expected Not signed in, got ${save.slice(0, 120)}`);
  });

  let firstId;
  let secondId;
  await step("sendNotification delivers and the onComplete handle fires", async () => {
    firstId = await notification({ title: "Smoke 1", idempotencyKey: `${run}-1` });
    secondId = await notification({
      title: "Smoke 2",
      idempotencyKey: `${run}-2`,
      ttlSeconds: 600,
      urgency: "high",
      topic: "smoke",
    });
    assertSmoke(
      firstId && secondId && firstId !== secondId,
      "expected two distinct notification ids",
    );
    const first = await settled(firstId, user);
    const second = await settled(secondId, user);
    assertSmoke(first.status === "delivered" && first.testMode === true, "first was not delivered");
    assertEqual(
      second.options,
      { ttlSeconds: 600, urgency: "high", topic: "smoke" },
      "second options",
    );
    const results = await waitFor(async () => {
      const rows = await call("listNotificationResults", { userId: user, testMode: true });
      return rows.length === 2 ? rows : null;
    });
    assertEqual(
      results.map((r) => [r.status, r.sent]),
      [
        ["delivered", 1],
        ["delivered", 1],
      ],
      "callback results",
    );
    const deliveries = await call("listDeliveries", {
      notificationId: firstId,
      userId: user,
    });
    assertEqual(deliveries, [{ status: "sent", attempts: 1 }], "first delivery");
  });

  await step("idempotencyKey returns the original notification", async () => {
    assertEqual(
      await notification({ title: "Smoke 1", idempotencyKey: `${run}-1` }),
      firstId,
      "repeated send",
    );
  });

  await step("the paginator pages notifications newest first", async () => {
    const first = await page(null, 1);
    const second = await page(first.continueCursor, 1);
    assertSmoke(first.page.length === 1 && first.isDone === false, "page 1 should have one row");
    assertSmoke(second.page.length === 1, "page 2 should have one row");
    assertEqual(
      [first.page[0].notificationId, second.page[0].notificationId],
      [secondId, firstId],
      "order",
    );
  });

  await step("history rejects malformed cursors and bounds endCursor pages", async () => {
    for (const cursor of ["not-json", "{}", "123", "[{}]", '["u",0,0,"\\ud800"]']) {
      assertEqual(
        await errorCode(page(cursor, 1)),
        "WEB_PUSH_INVALID_ARGUMENT",
        "malformed cursor",
      );
    }
    assertEqual(await errorCode(page(null, 101)), "WEB_PUSH_INVALID_ARGUMENT", "page size");
    const last = await page(null, 100);
    const bounded = await call("listNotifications", {
      userId: user,
      paginationOpts: {
        numItems: 1,
        cursor: null,
        endCursor: last.continueCursor,
        maximumRowsRead: 10000,
      },
    });
    assertSmoke(bounded.page.length <= 2, "endCursor exceeded the server row budget");
  });
  await step(
    "registration accepts a Unicode truncation boundary and rejects an invalid point",
    async () => {
      const unicode = await fakeSubscription();
      await call("recordSubscription", {
        userId: user + "-unicode",
        subscription: unicode,
        userAgent: "a".repeat(255) + "😀",
      });
      const point = Buffer.alloc(65);
      point[0] = 4;
      assertEqual(
        await errorCode(
          call("recordSubscription", {
            userId: user,
            subscription: {
              ...unicode,
              keys: { ...unicode.keys, p256dh: point.toString("base64url") },
            },
          }),
        ),
        "WEB_PUSH_INVALID_ARGUMENT",
        "invalid curve point",
      );
    },
  );

  await step("sendRaw delivers a string and bytes", async () => {
    const text = await call("sendRawNotification", {
      userId: user,
      payload: "custom:smoke",
    });
    const bytes = await call("sendRawNotification", {
      userId: user,
      payload: new Uint8Array([0, 255, 128, 7]).buffer,
    });
    assertSmoke((await settled(text, user)).payload === "custom:smoke", "string payload changed");
    assertSmoke(
      (await settled(bytes, user)).payload === "AP-ABw",
      "bytes were not stored as base64url",
    );
  });

  await step("pause stops delivery and resume restores it", async () => {
    assertSmoke(
      (await call("pauseSubscriptions", { userId: user })) === 1,
      "pause should affect one subscription",
    );
    assertSmoke(
      (await call("getSubscriptionStatus", { userId: user })).pausedCount === 1,
      "status should show one paused subscription",
    );
    assertSmoke((await notification({ title: "while paused" })) === null, "paused user got a send");
    assertSmoke((await call("resumeSubscriptions", { userId: user })) === 1, "resume failed");
    const id = await notification({ title: "after resume" });
    assertSmoke(
      id !== null && (await settled(id, user)).status === "delivered",
      "resume did not restore",
    );
  });

  const deviceUser = `${user}-device`;
  await step(
    "subscriptions.get reads one endpoint and an endpoint send reaches only it",
    async () => {
      const device = await fakeSubscription();
      await call("recordSubscription", { userId: deviceUser, subscription: device });
      await call("recordSubscription", {
        userId: deviceUser,
        subscription: await fakeSubscription(),
      });
      const found = await call("getSubscription", {
        userId: deviceUser,
        endpoint: device.endpoint,
      });
      assertSmoke(
        found?.status === "active",
        `expected an active subscription, got ${canonical(found)}`,
      );
      assertEqual(
        await call("getSubscription", { userId: user, endpoint: device.endpoint }),
        null,
        "another user's endpoint",
      );
      const id = await call("sendNotification", {
        userId: deviceUser,
        title: "this device",
        endpoint: device.endpoint,
      });
      const done = await settled(id, deviceUser);
      assertEqual(done.counts, { queued: 0, sent: 1, failed: 0, gone: 0 }, "endpoint send counts");
    },
  );

  await step("users.purge deletes the user's subscriptions and notifications", async () => {
    const result = await call("purgeUser", { userId: deviceUser });
    assertEqual(result, { removed: 4, done: true }, "purge result");
    assertEqual(
      (await call("getSubscriptionStatus", { userId: deviceUser })).activeCount,
      0,
      "subscriptions left",
    );
    assertEqual(
      (
        await call("listNotifications", {
          userId: deviceUser,
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page,
      [],
      "notifications left",
    );
  });

  await step("a batch continues in a scheduled mutation until every user is handled", async () => {
    const users = Array.from({ length: BROADCAST_USERS }, (_, i) => `${user}-b${i}`);
    const recordings = users.flatMap((id) =>
      Array.from({ length: PER_USER_SUBSCRIPTIONS }, () => id),
    );
    await inChunks(recordings, 8, async (userId) =>
      call("recordSubscription", {
        userId,
        subscription: await fakeSubscription(),
      }),
    );
    const first = await call("sendBatch", { userIds: users, title: "News" });
    assertSmoke(first.done === false, "the first call should hit the delivery budget");
    assertSmoke(first.results.length < users.length, "the first call handled every user");
    const progress = await waitFor(async () => {
      const current = await call("getBatch", { batchId: first.batchId });
      return current?.status === "done" ? current : null;
    });
    assertEqual([progress.total, progress.processed], [BROADCAST_USERS, BROADCAST_USERS], "counts");
    assertSmoke(progress.notificationIds.length === BROADCAST_USERS, "a notification is missing");

    const ids = progress.notificationIds;
    const sample = [0, 1, 39, 40, 78, 79].map((i) => ({ id: ids[i], userId: users[i] }));
    await inChunks(sample, 3, async ({ id, userId }) => {
      const done = await settled(id, userId);
      assertSmoke(done.counts.sent === PER_USER_SUBSCRIPTIONS, `${id} was not fully delivered`);
    });
  });

  await step("a batch over 100 users fails with WEB_PUSH_INVALID_ARGUMENT", async () => {
    const code = await errorCode(
      call("sendBatch", {
        userIds: Array.from({ length: 101 }, (_, i) => `${user}-x${i}`),
        title: "too many",
      }),
    );
    assertEqual(code, "WEB_PUSH_INVALID_ARGUMENT", "error code");
  });

  await step("an invalid TTL fails for a user without subscriptions", async () => {
    const code = await errorCode(
      call("sendNotification", { userId: `${user}-none`, title: "bad ttl", ttlSeconds: -1 }),
    );
    assertEqual(code, "WEB_PUSH_INVALID_ARGUMENT", "error code");
  });

  await step(
    "an oversized notification fails on the client with the same error shape",
    async () => {
      const code = await errorCode(notification({ title: "big", body: "a".repeat(4000) }));
      assertEqual(code, "WEB_PUSH_PAYLOAD_TOO_LARGE", "error code");
    },
  );

  await step(
    "unset test mode means live, so sending without a private key fails with WEB_PUSH_NOT_CONFIGURED",
    async () => {
      try {
        await backend.runConvexCli(["env", "remove", "WEB_PUSH_TEST_MODE"]);
        await backend.runConvexCli(["env", "remove", "WEB_PUSH_VAPID_PRIVATE_KEY"]);
        const code = await waitFor(async () => {
          const result = await errorCode(notification({ title: "unconfigured" }));
          return result === "WEB_PUSH_NOT_CONFIGURED" ? result : null;
        });
        assertEqual(code, "WEB_PUSH_NOT_CONFIGURED", "error code");
      } finally {
        await backend.setEnvironmentVariable(
          "WEB_PUSH_VAPID_PRIVATE_KEY",
          keys.WEB_PUSH_VAPID_PRIVATE_KEY,
        );
        await backend.setEnvironmentVariable("WEB_PUSH_TEST_MODE", "true");
      }
    },
  );

  await step("cleanup deletes finished rows past retention", async () => {
    await waitFor(async () => {
      const report = await call("verifyConfig", {});
      return report.testMode && report.config.configured;
    });
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    const result = await backend.runFunction(
      "cleanup:run",
      { now: Date.now() + eightDays },
      { component: "webPush" },
    );
    assertSmoke(result.deleted > 0, `cleanup deleted nothing: ${JSON.stringify(result)}`);
    assertEqual(
      await errorCode(detail(firstId, user)),
      "WEB_PUSH_NOT_FOUND",
      "deleted notification",
    );
    assertEqual((await page(null, 10)).page, [], "history after cleanup");
  });

  await step("removeAll removes the user's subscriptions", async () => {
    const removed = await call("removeAll", { userId: user });
    assertEqual(removed, { removed: 1, done: true }, "removeAll");
    assertEqual(
      (await call("getSubscriptionStatus", { userId: user })).activeCount,
      0,
      "subscriptions left",
    );
  });
});
