import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { runSmoke, smokeEnv, step } from "./smoke-harness.mjs";

const root = resolve(import.meta.dirname, "..");
const api = anyApi;
const VAPID_ENV_NAMES = [
  "WEB_PUSH_VAPID_PRIVATE_KEY",
  "WEB_PUSH_VAPID_PUBLIC_KEY",
  "WEB_PUSH_VAPID_SUBJECT",
];
const BROADCAST_USERS = 80;
const PER_USER_SUBSCRIPTIONS = 2;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonical(value) {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function assertEqual(actual, expected, what) {
  assert(
    canonical(actual) === canonical(expected),
    `${what}: expected ${canonical(expected)}, got ${canonical(actual)}`,
  );
}

async function waitFor(what, fn, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
}

function callWith(backend) {
  return async (name, args = {}) => {
    try {
      return await backend.runFunction(name, args);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const failure = new Error(text.slice(0, 400));
      const code = /WEB_PUSH_[A-Z_]+/.exec(text)?.[0];
      if (code) failure.data = { code };
      throw failure;
    }
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
    return error?.data?.code ?? `no code (${String(error?.message).slice(0, 120)})`;
  }
  return "no error";
}

await runSmoke(async (backend) => {
  const run = crypto.randomUUID().slice(0, 8);
  const user = `smoke-${run}`;
  const call = callWith(backend);
  const notification = (args) => call("admin:sendNotification", { userId: user, ...args });
  const page = (cursor, numItems) =>
    call("admin:listNotifications", { userId: user, paginationOpts: { numItems, cursor } });
  const detail = (notificationId, userId) =>
    call("admin:getNotification", { notificationId, userId });
  const settled = (notificationId, userId) =>
    waitFor(`notification ${notificationId} to settle`, async () => {
      const found = await detail(notificationId, userId);
      return found && ["delivered", "failed"].includes(found.status) ? found : null;
    });

  const keys = generateKeys();
  for (const [name, value] of Object.entries({ ...keys, WEB_PUSH_TEST_MODE: "true" }))
    await backend.setEnvironmentVariable(name, value);

  await step(
    "config.verify passes every WebCrypto operation and config.get returns the configured key",
    async () => {
      const report = await waitFor("the env to reach the component", async () => {
        const result = await call("admin:verifyConfig", {});
        return result.config.configured && result.testMode ? result : null;
      });
      assert(report.ok === true, `verifyConfig failed: ${JSON.stringify(report.checks)}`);
      assert(
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
    const saved = await call("admin:recordSubscription", {
      userId: user,
      subscription,
    });
    assert(saved.created === true, "the subscription was not created");
    const evil = { ...(await fakeSubscription()), endpoint: "https://evil.example.com/push" };
    const code = await errorCode(
      call("admin:recordSubscription", { userId: user, subscription: evil }),
    );
    assertEqual(code, "WEB_PUSH_INVALID_ARGUMENT", "error code for a disallowed endpoint");
  });

  await step("the public functions reject a caller who is not signed in", async () => {
    const client = new ConvexHttpClient(backend.url, { logger: false });
    const mutation = client.mutation(api.example.notifyMe, { title: "nope" });
    const message = await mutation.then(
      () => "no error",
      (error) => String(error?.message),
    );
    assert(/Not signed in/.test(message), `expected Not signed in, got ${message.slice(0, 120)}`);
    const save = await client
      .mutation(api.example.recordSubscription, { subscription: await fakeSubscription() })
      .then(
        () => "no error",
        (error) => String(error?.message),
      );
    assert(/Not signed in/.test(save), `expected Not signed in, got ${save.slice(0, 120)}`);
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
    assert(firstId && secondId && firstId !== secondId, "expected two distinct notification ids");
    const first = await settled(firstId, user);
    const second = await settled(secondId, user);
    assert(first.status === "delivered" && first.testMode === true, "first was not delivered");
    assertEqual(
      second.options,
      { ttlSeconds: 600, urgency: "high", topic: "smoke" },
      "second options",
    );
    const results = await waitFor("both onComplete callbacks", async () => {
      const rows = await call("admin:listNotificationResults", { userId: user, testMode: true });
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
    const deliveries = await call("admin:listDeliveries", {
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
    assert(first.page.length === 1 && first.isDone === false, "page 1 should have one row");
    assert(second.page.length === 1, "page 2 should have one row");
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
    const bounded = await call("admin:listNotifications", {
      userId: user,
      paginationOpts: {
        numItems: 1,
        cursor: null,
        endCursor: last.continueCursor,
        maximumRowsRead: 10000,
      },
    });
    assert(bounded.page.length <= 2, "endCursor exceeded the server row budget");
  });
  await step(
    "registration accepts a Unicode truncation boundary and rejects an invalid point",
    async () => {
      const unicode = await fakeSubscription();
      await call("admin:recordSubscription", {
        userId: user + "-unicode",
        subscription: unicode,
        userAgent: "a".repeat(255) + "😀",
      });
      const point = Buffer.alloc(65);
      point[0] = 4;
      assertEqual(
        await errorCode(
          call("admin:recordSubscription", {
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
    const text = await call("admin:sendRawNotification", {
      userId: user,
      payload: "custom:smoke",
    });
    const bytes = await call("admin:sendRawNotification", {
      userId: user,
      payload: { $bytes: Buffer.from([0, 255, 128, 7]).toString("base64") },
    });
    assert((await settled(text, user)).payload === "custom:smoke", "string payload changed");
    assert((await settled(bytes, user)).payload === "AP-ABw", "bytes were not stored as base64url");
  });

  await step("pause stops delivery and resume restores it", async () => {
    assert(
      (await call("admin:pauseSubscriptions", { userId: user })) === 1,
      "pause should affect one subscription",
    );
    assert(
      (await call("admin:getSubscriptionStatus", { userId: user })).pausedCount === 1,
      "status should show one paused subscription",
    );
    assert((await notification({ title: "while paused" })) === null, "paused user got a send");
    assert((await call("admin:resumeSubscriptions", { userId: user })) === 1, "resume failed");
    const id = await notification({ title: "after resume" });
    assert(
      id !== null && (await settled(id, user)).status === "delivered",
      "resume did not restore",
    );
  });

  await step("a batch continues in a scheduled mutation until every user is handled", async () => {
    const users = Array.from({ length: BROADCAST_USERS }, (_, i) => `${user}-b${i}`);
    const recordings = users.flatMap((id) =>
      Array.from({ length: PER_USER_SUBSCRIPTIONS }, () => id),
    );
    await inChunks(recordings, 8, async (userId) =>
      call("admin:recordSubscription", {
        userId,
        subscription: await fakeSubscription(),
      }),
    );
    const first = await call("admin:sendBatch", { userIds: users, title: "News" });
    assert(first.done === false, "the first call should hit the delivery budget");
    assert(first.results.length < users.length, "the first call handled every user");
    const progress = await waitFor("the batch to finish", async () => {
      const current = await call("admin:getBatch", { batchId: first.batchId });
      return current?.status === "done" ? current : null;
    });
    assertEqual([progress.total, progress.processed], [BROADCAST_USERS, BROADCAST_USERS], "counts");
    assert(progress.notificationIds.length === BROADCAST_USERS, "a notification is missing");

    const ids = progress.notificationIds;
    const sample = [0, 1, 39, 40, 78, 79].map((i) => ({ id: ids[i], userId: users[i] }));
    await inChunks(sample, 3, async ({ id, userId }) => {
      const done = await settled(id, userId);
      assert(done.counts.sent === PER_USER_SUBSCRIPTIONS, `${id} was not fully delivered`);
    });
  });

  await step("a batch over 100 users fails with WEB_PUSH_INVALID_ARGUMENT", async () => {
    const code = await errorCode(
      call("admin:sendBatch", {
        userIds: Array.from({ length: 101 }, (_, i) => `${user}-x${i}`),
        title: "too many",
      }),
    );
    assertEqual(code, "WEB_PUSH_INVALID_ARGUMENT", "error code");
  });

  await step("an invalid TTL fails for a user without subscriptions", async () => {
    const code = await errorCode(
      call("admin:sendNotification", { userId: `${user}-none`, title: "bad ttl", ttlSeconds: -1 }),
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
        const code = await waitFor("the missing private key", async () => {
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
    await waitFor("test mode to come back", async () => {
      const report = await call("admin:verifyConfig", {});
      return report.testMode && report.config.configured;
    });
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    const result = await backend.runFunction(
      "cleanup:run",
      { now: Date.now() + eightDays },
      { component: "webPush" },
    );
    assert(result.deleted > 0, `cleanup deleted nothing: ${JSON.stringify(result)}`);
    assertEqual(
      await errorCode(detail(firstId, user)),
      "WEB_PUSH_NOT_FOUND",
      "deleted notification",
    );
    assertEqual((await page(null, 10)).page, [], "history after cleanup");
  });

  await step("removeAll removes the user's subscriptions", async () => {
    const removed = await call("admin:removeAll", { userId: user });
    assertEqual(removed, { removed: 1, done: true }, "removeAll");
    assertEqual(
      (await call("admin:getSubscriptionStatus", { userId: user })).activeCount,
      0,
      "subscriptions left",
    );
  });
});
