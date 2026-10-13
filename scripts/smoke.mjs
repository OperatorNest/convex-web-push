import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { acquireLock } from "./with-local-lock.mjs";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "web-push-smoke-"));
const api = anyApi;
const execFileAsync = promisify(execFile);
const SMOKE_ENV = [
  "WEB_PUSH_VAPID_PUBLIC_KEY",
  "WEB_PUSH_VAPID_PRIVATE_KEY",
  "WEB_PUSH_VAPID_SUBJECT",
  "WEB_PUSH_TEST_MODE",
];
const cliEnv = { ...process.env, CONVEX_AGENT_MODE: "anonymous" };
for (const name of [
  "CONVEX_DEPLOYMENT",
  "CONVEX_DEPLOY_KEY",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
])
  delete cliEnv[name];

const BROADCAST_USERS = 80;
const PER_USER_SUBSCRIPTIONS = 2;

const steps = [];
const failures = [];
let stepNumber = 0;

async function step(name, fn) {
  stepNumber += 1;
  const label = `${String(stepNumber).padStart(2, "0")} ${name}`;
  try {
    await fn();
    steps.push({ label, ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push({ label, ok: false, message });
    failures.push(`${label}: ${message}`);
  }
}

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

function convexCli(...args) {
  return execFileSync("pnpm", ["exec", "convex", ...args], {
    encoding: "utf8",
    env: cliEnv,
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseRunOutput(stdout) {
  if (stdout.trim() === "") return null;
  const lines = stdout.trim().split("\n");
  for (let i = 0; i < lines.length; i++) {
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {
      // Not JSON yet: this line is a log line.
    }
  }
  throw new Error(`Unparseable convex run output: ${stdout.slice(0, 200)}`);
}

async function call(name, args = {}) {
  try {
    const { stdout } = await execFileAsync(
      "pnpm",
      ["exec", "convex", "run", name, JSON.stringify(args)],
      { cwd: workspace, env: cliEnv, maxBuffer: 10 * 1024 * 1024 },
    );
    return parseRunOutput(stdout);
  } catch (error) {
    const text = `${error.stderr ?? ""}${error.stdout ?? ""}${error.message}`;
    const failure = new Error(text.slice(0, 400));
    const code = /WEB_PUSH_[A-Z_]+/.exec(text)?.[0];
    if (code) failure.data = { code };
    throw failure;
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePort);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "No ephemeral port available");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}
async function startDev() {
  for (const path of ["src", "dist", "example", "package.json", "convex.json"])
    cpSync(join(root, path), join(workspace, path), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
  const cloud = await freePort();
  const site = await freePort();
  const child = spawn(
    "pnpm",
    [
      "exec",
      "convex",
      "dev",
      "--typecheck",
      "disable",
      "--tail-logs",
      "disable",
      "--local-cloud-port",
      String(cloud),
      "--local-site-port",
      String(site),
    ],
    { cwd: workspace, env: cliEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const collect = (chunk) => {
    output += chunk.toString();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      sleep(15_000),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  try {
    await waitFor(
      "convex dev to push the functions",
      () => {
        if (child.exitCode !== null) {
          throw new Error(`convex dev exited with ${child.exitCode}:\n${output.slice(-2000)}`);
        }
        return /Convex functions ready/.test(output);
      },
      300_000,
    );
  } catch (error) {
    await stop();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n--- convex dev output ---\n${output.slice(-2000)}`, {
      cause: error,
    });
  }
  return { stop, output: () => output };
}

function deploymentUrl() {
  const config = JSON.parse(
    readFileSync(join(workspace, ".convex/local/default/config.json"), "utf8"),
  );
  return `http://127.0.0.1:${config.ports.cloud}`;
}

function generateKeys() {
  const out = execFileSync(
    "node",
    [
      join(root, "bin/convex-web-push.js"),
      "generate-keys",
      "--subject",
      "mailto:smoke@example.com",
    ],
    { encoding: "utf8", env: cliEnv },
  );
  const entries = out
    .split("\n")
    .filter((line) => /^WEB_PUSH_VAPID_[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
  assertEqual(
    entries.map(([name]) => name).toSorted(),
    SMOKE_ENV.slice(0, 3).toSorted(),
    "CLI env lines",
  );
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

const detail = (notificationId, userId) =>
  call("admin:getNotification", { notificationId, userId });

const settled = (notificationId, userId) =>
  waitFor(`notification ${notificationId} to settle`, async () => {
    const found = await detail(notificationId, userId);
    return found && ["delivered", "failed"].includes(found.status) ? found : null;
  });

async function main(client) {
  const run = crypto.randomUUID().slice(0, 8);
  const user = `smoke-${run}`;
  const notification = (args) => call("admin:sendNotification", { userId: user, ...args });
  const page = (cursor, numItems) =>
    call("admin:listNotifications", { userId: user, paginationOpts: { numItems, cursor } });

  const keys = generateKeys();
  for (const [name, value] of Object.entries({ ...keys, WEB_PUSH_TEST_MODE: "true" })) {
    convexCli("env", "set", "--", name, value);
  }

  await step(
    "verifyDeliveries passes every WebCrypto operation with the configured keys",
    async () => {
      const report = await waitFor("the env to reach the component", async () => {
        const result = await call("admin:verifyDeliveries", {});
        return result.config.configured && result.testMode ? result : null;
      });
      assert(report.ok === true, `verifyDeliveries failed: ${JSON.stringify(report.checks)}`);
      assert(
        report.checks.some((c) => c.name === "RFC 8291 Appendix A vector" && c.ok),
        "the RFC 8291 vector check did not pass",
      );
      assert(
        report.checks.some((c) => c.name === "configured VAPID key pair matches" && c.ok),
        "the configured key pair was not verified",
      );
      assert(
        JSON.parse(
          convexCli(
            "run",
            "--component",
            "webPush",
            "subscriptions:readApplicationServerKey",
            "{}",
          ),
        ) === keys.WEB_PUSH_VAPID_PUBLIC_KEY,
        "applicationServerKey did not return the configured key",
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
      (await call("admin:getSubscriptionStatus", { userId: user })).paused === 1,
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

  await step(
    "an oversized notification fails on the client with the same error shape",
    async () => {
      const code = await errorCode(notification({ title: "big", body: "a".repeat(4000) }));
      assertEqual(code, "WEB_PUSH_PAYLOAD_TOO_LARGE", "error code");
    },
  );

  await step(
    "sending without a test-mode decision fails with WEB_PUSH_INVALID_ARGUMENT",
    async () => {
      try {
        convexCli("env", "remove", "WEB_PUSH_TEST_MODE");
        const code = await waitFor("the missing test-mode decision", async () => {
          const result = await errorCode(notification({ title: "undecided" }));
          return result === "WEB_PUSH_INVALID_ARGUMENT" ? result : null;
        });
        assertEqual(code, "WEB_PUSH_INVALID_ARGUMENT", "error code");
      } finally {
        convexCli("env", "set", "WEB_PUSH_TEST_MODE", "true");
      }
    },
  );

  await step("live sending without a private key fails with WEB_PUSH_NOT_CONFIGURED", async () => {
    try {
      convexCli("env", "set", "WEB_PUSH_TEST_MODE", "false");
      convexCli("env", "remove", "WEB_PUSH_VAPID_PRIVATE_KEY");
      const code = await waitFor("the missing private key", async () => {
        const result = await errorCode(notification({ title: "unconfigured" }));
        return result === "WEB_PUSH_NOT_CONFIGURED" ? result : null;
      });
      assertEqual(code, "WEB_PUSH_NOT_CONFIGURED", "error code");
    } finally {
      convexCli("env", "set", "--", "WEB_PUSH_VAPID_PRIVATE_KEY", keys.WEB_PUSH_VAPID_PRIVATE_KEY);
      convexCli("env", "set", "WEB_PUSH_TEST_MODE", "true");
    }
  });

  await step("cleanup deletes finished rows past retention", async () => {
    await waitFor("test mode to come back", async () => {
      const report = await call("admin:verifyDeliveries", {});
      return report.testMode && report.config.configured;
    });
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    const out = convexCli(
      "run",
      "--component",
      "webPush",
      "cleanup:run",
      JSON.stringify({ now: Date.now() + eightDays }),
    );
    const result = JSON.parse(out.slice(out.indexOf("{")));
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
      (await call("admin:getSubscriptionStatus", { userId: user })).subscriptions,
      0,
      "subscriptions left",
    );
  });
}

const release = await acquireLock();
let dev;
try {
  console.log("Building the package...");
  execFileSync("pnpm", ["build"], { cwd: root, env: cliEnv, stdio: "inherit" });
  console.log("Starting the local Convex backend and pushing the example app...");
  dev = await startDev();
  const url = deploymentUrl(dev.output());
  console.log(`Local deployment ready at ${url}`);
  await main(new ConvexHttpClient(url));
} catch (error) {
  failures.push(`fatal: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const name of SMOKE_ENV) {
    try {
      convexCli("env", "remove", name);
    } catch {
      // Already unset, or the backend is gone.
    }
  }
  await dev?.stop();
  rmSync(workspace, { recursive: true, force: true });
  release();
}

console.log("\nSmoke summary");
for (const s of steps) console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.label}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):\n  ${failures.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${steps.length} steps passed in the real Convex runtime.`);
}
