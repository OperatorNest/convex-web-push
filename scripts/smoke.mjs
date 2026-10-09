// Real-runtime smoke test. Builds the package, starts `convex dev` against the anonymous local
// backend (bootstrapping it when there is none, so CI needs no login), then drives the example app
// over HTTP. convex-test is a simulator; this checks the paths it cannot: the paginator, batches
// that continue in scheduled mutations, function handles, retention and typed errors.
// Local only: it never talks to a cloud deployment or a real push service.
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { acquireLock } from "./with-local-lock.mjs";

const api = anyApi;
const execFileAsync = promisify(execFile);
const SMOKE_ENV = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "WEB_PUSH_TEST_MODE"];
const cliEnv = { ...process.env, CONVEX_AGENT_MODE: "anonymous" };
// 80 users with two subscriptions each is 160 deliveries, above the 150-delivery budget of one
// batch transaction, so the batch has to continue in a scheduled mutation.
const BROADCAST_USERS = 80;
const PER_USER_SUBSCRIPTIONS = 2;

const steps = [];
const failures = [];
let stepNumber = 0;

/** Runs one numbered step. Every step asserts something, and a failure does not stop the run. */
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

/** JSON with sorted keys, so comparisons ignore property order. */
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
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Parses `convex run` output: the JSON result is the last block, after any log lines. */
function parseRunOutput(stdout) {
  // A function that returns null prints nothing.
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

/**
 * Runs an internal function from example/convex/admin.ts. Those functions are not callable from a
 * browser, so the smoke test uses the CLI, which authenticates as the deployment admin.
 */
async function call(name, args = {}) {
  try {
    const { stdout } = await execFileAsync(
      "pnpm",
      ["exec", "convex", "run", name, JSON.stringify(args)],
      { env: cliEnv, maxBuffer: 10 * 1024 * 1024 },
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

/** Starts `convex dev` and resolves once the functions are pushed and the backend is serving. */
async function startDev() {
  const child = spawn(
    "pnpm",
    ["exec", "convex", "dev", "--typecheck", "disable", "--tail-logs", "disable"],
    { env: cliEnv, stdio: ["ignore", "pipe", "pipe"] },
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
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(15_000)]);
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

/** The deployment URL: from .env.local, which `convex dev` writes, or else from the CLI output. */
function deploymentUrl(output) {
  if (existsSync(".env.local")) {
    const match = /^CONVEX_URL=(\S+)$/m.exec(readFileSync(".env.local", "utf8"));
    if (match?.[1]) return match[1];
  }
  const fromOutput = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/.exec(output);
  if (fromOutput) return fromOutput[0];
  throw new Error("Could not find the local deployment URL in .env.local or the CLI output");
}

function generateKeys() {
  const out = execFileSync(
    "node",
    ["bin/convex-web-push.js", "generate-keys", "--subject", "mailto:smoke@example.com"],
    { encoding: "utf8" },
  );
  const entries = out
    .split("\n")
    .filter((line) => /^VAPID_[A-Z_]+=/.test(line))
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

const detail = (notificationId) => call("admin:notification", { notificationId });

const settled = (notificationId) =>
  waitFor(`notification ${notificationId} to settle`, async () => {
    const found = await detail(notificationId);
    return found && ["delivered", "failed"].includes(found.status) ? found : null;
  });

async function main(client) {
  const run = crypto.randomUUID().slice(0, 8);
  const user = `smoke-${run}`;
  const notification = (args) => call("admin:notify", { userId: user, ...args });
  const page = (cursor, numItems) =>
    call("admin:notifications", { userId: user, paginationOpts: { numItems, cursor } });

  const keys = generateKeys();
  for (const [name, value] of Object.entries({ ...keys, WEB_PUSH_TEST_MODE: "true" })) {
    convexCli("env", "set", "--", name, value);
  }

  await step("selfTest passes every WebCrypto operation with the configured keys", async () => {
    // Polls because the env change reaches the running backend asynchronously.
    const report = await waitFor("the env to reach the component", async () => {
      const result = await call("admin:selfTest", {});
      return result.config.configured && result.testMode ? result : null;
    });
    assert(report.ok === true, `selfTest failed: ${JSON.stringify(report.checks)}`);
    assert(
      report.checks.some((c) => c.name === "RFC 8291 Appendix A vector" && c.ok),
      "the RFC 8291 vector check did not pass",
    );
    assert(
      report.checks.some((c) => c.name === "configured VAPID key pair matches" && c.ok),
      "the configured key pair was not verified",
    );
    assert(
      (await client.query(api.example.publicKey, {})) === keys.VAPID_PUBLIC_KEY,
      "getPublicKey did not return the configured key",
    );
  });

  const subscription = await fakeSubscription();
  await step("recordSubscription stores a subscription and rejects a bad endpoint", async () => {
    const saved = await call("admin:saveSubscription", {
      userId: user,
      subscription,
    });
    assert(saved.created === true, "the subscription was not created");
    const evil = { ...(await fakeSubscription()), endpoint: "https://evil.example.com/push" };
    const code = await errorCode(
      call("admin:saveSubscription", { userId: user, subscription: evil }),
    );
    assertEqual(code, "WEB_PUSH_INVALID_SUBSCRIPTION", "error code for a disallowed endpoint");
  });

  await step("the public functions reject a caller who is not signed in", async () => {
    const mutation = client.mutation(api.example.notifyMe, { title: "nope" });
    const message = await mutation.then(
      () => "no error",
      (error) => String(error?.message),
    );
    assert(/Not signed in/.test(message), `expected Not signed in, got ${message.slice(0, 120)}`);
    const save = await client
      .mutation(api.example.saveSubscription, { subscription: await fakeSubscription() })
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
      ttl: 600,
      urgency: "high",
      topic: "smoke",
    });
    assert(firstId && secondId && firstId !== secondId, "expected two distinct notification ids");
    const first = await settled(firstId);
    const second = await settled(secondId);
    assert(first.status === "delivered" && first.testMode === true, "first was not delivered");
    assertEqual(second.options, { ttl: 600, urgency: "high", topic: "smoke" }, "second options");
    const results = await waitFor("both onComplete callbacks", async () => {
      const rows = await call("admin:completedResults", { userId: user });
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
    const deliveries = await call("admin:deliveries", { notificationId: firstId });
    assertEqual(deliveries, [{ status: "sent", attempts: 1 }], "first delivery");
  });

  await step("idempotencyKey returns the original notification", async () => {
    assertEqual(
      await notification({ title: "Smoke 1 again", idempotencyKey: `${run}-1` }),
      firstId,
      "repeated send",
    );
  });

  await step("the paginator pages notifications newest first", async () => {
    const first = await page(null, 1);
    const second = await page(first.continueCursor, 1);
    assert(first.page.length === 1 && first.isDone === false, "page 1 should have one row");
    assert(second.page.length === 1, "page 2 should have one row");
    assertEqual([first.page[0].id, second.page[0].id], [secondId, firstId], "order");
  });

  await step("sendRaw delivers a string and bytes", async () => {
    const text = await call("admin:notifyRaw", {
      userId: user,
      payload: "custom:smoke",
    });
    const bytes = await call("admin:notifyRaw", {
      userId: user,
      payload: { $bytes: Buffer.from([0, 255, 128, 7]).toString("base64") },
    });
    assert((await settled(text)).payload === "custom:smoke", "string payload changed");
    assert((await settled(bytes)).payload === "AP-ABw", "bytes were not stored as base64url");
  });

  await step("pause stops delivery and resume restores it", async () => {
    assert(
      (await call("admin:pause", { userId: user })) === 1,
      "pause should affect one subscription",
    );
    assert(
      (await call("admin:userStatus", { userId: user })).paused === 1,
      "status should show one paused subscription",
    );
    assert((await notification({ title: "while paused" })) === null, "paused user got a send");
    assert((await call("admin:resume", { userId: user })) === 1, "resume failed");
    const id = await notification({ title: "after resume" });
    assert(id !== null && (await settled(id)).status === "delivered", "resume did not restore");
  });

  await step("a batch continues in a scheduled mutation until every user is handled", async () => {
    const users = Array.from({ length: BROADCAST_USERS }, (_, i) => `${user}-b${i}`);
    const recordings = users.flatMap((id) =>
      Array.from({ length: PER_USER_SUBSCRIPTIONS }, () => id),
    );
    await inChunks(recordings, 8, async (userId) =>
      call("admin:saveSubscription", {
        userId,
        subscription: await fakeSubscription(),
      }),
    );
    const first = await call("admin:broadcast", { userIds: users, title: "News" });
    assert(first.done === false, "the first call should hit the delivery budget");
    assert(first.results.length < users.length, "the first call handled every user");
    const progress = await waitFor("the batch to finish", async () => {
      const current = await call("admin:batchProgress", { batchId: first.batchId });
      return current?.status === "done" ? current : null;
    });
    assertEqual([progress.total, progress.processed], [BROADCAST_USERS, BROADCAST_USERS], "counts");
    assert(progress.notificationIds.length === BROADCAST_USERS, "a notification is missing");
    // Sampled: each check is a CLI call.
    const ids = progress.notificationIds;
    const sample = [0, 1, 39, 40, 78, 79].map((i) => ids[i]);
    await inChunks(sample, 3, async (id) => {
      const done = await settled(id);
      assert(done.counts.sent === PER_USER_SUBSCRIPTIONS, `${id} was not fully delivered`);
    });
  });

  await step("a batch over 100 users fails with WEB_PUSH_BATCH_TOO_LARGE", async () => {
    const code = await errorCode(
      call("admin:broadcast", {
        userIds: Array.from({ length: 101 }, (_, i) => `${user}-x${i}`),
        title: "too many",
      }),
    );
    assertEqual(code, "WEB_PUSH_BATCH_TOO_LARGE", "error code");
  });

  await step(
    "an oversized notification fails on the client with the same error shape",
    async () => {
      const code = await errorCode(notification({ title: "big", body: "a".repeat(4000) }));
      assertEqual(code, "WEB_PUSH_PAYLOAD_TOO_LARGE", "error code");
    },
  );

  await step("without opt-in, sending fails with WEB_PUSH_NOT_CONFIGURED", async () => {
    convexCli("env", "remove", "WEB_PUSH_TEST_MODE");
    convexCli("env", "remove", "VAPID_PRIVATE_KEY");
    const code = await waitFor("the env removal to take effect", async () => {
      const result = await errorCode(notification({ title: "unconfigured" }));
      return result === "no error" ? null : result;
    });
    assertEqual(code, "WEB_PUSH_NOT_CONFIGURED", "error code");
    convexCli("env", "set", "--", "VAPID_PRIVATE_KEY", keys.VAPID_PRIVATE_KEY);
    convexCli("env", "set", "WEB_PUSH_TEST_MODE", "true");
  });

  await step("cleanup deletes finished rows past retention", async () => {
    await waitFor("test mode to come back", async () => {
      const report = await call("admin:selfTest", {});
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
    assert((await detail(firstId)) === null, "the old notification survived cleanup");
    assertEqual((await page(null, 10)).page, [], "history after cleanup");
  });

  await step("removeAllForUser removes the user's subscriptions", async () => {
    const removed = await call("admin:removeAllForUser", { userId: user });
    assertEqual(removed, { removed: 1, done: true }, "removeAllForUser");
    assertEqual(
      (await call("admin:userStatus", { userId: user })).subscriptions,
      0,
      "subscriptions left",
    );
  });
}

const release = await acquireLock();
let dev;
try {
  console.log("Building the package...");
  execFileSync("pnpm", ["build"], { stdio: "inherit" });
  console.log("Starting the local Convex backend and pushing the example app...");
  dev = await startDev();
  const url = deploymentUrl(dev.output());
  console.log(`Local deployment ready at ${url}`);
  await main(new ConvexHttpClient(url));
} catch (error) {
  failures.push(`fatal: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // Leave the local deployment as we found it: none of the env this script set stays behind.
  for (const name of SMOKE_ENV) {
    try {
      convexCli("env", "remove", name);
    } catch {
      // Already unset, or the backend is gone.
    }
  }
  await dev?.stop();
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
