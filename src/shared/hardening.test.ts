import { ConvexError } from "convex/values";
import { afterEach, expect, test, vi } from "vitest";
import { isWebPushError } from "./errors.js";
import { serializeNotification } from "./notification.js";
import {
  generateVapidKeys,
  validateVapidSubject,
  vapidKeyFingerprint,
  importVapidPrivateKey,
} from "./vapid.js";
import { runCli } from "./cli.js";
import { sendWebPush } from "./send.js";
import { makeSubscription } from "../test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("the error guard rejects malformed messages and provider statuses", () => {
  expect(isWebPushError(new ConvexError({ code: "WEB_PUSH_INVALID_PAYLOAD", message: 3 }))).toBe(
    false,
  );
  expect(
    isWebPushError(
      new ConvexError({ code: "WEB_PUSH_INVALID_PAYLOAD", message: "x", providerStatus: "500" }),
    ),
  ).toBe(false);
});
test("serialization rejects a toJSON result that is undefined", () => {
  expect(() =>
    serializeNotification({ title: "x", toJSON: () => undefined } as { title: string }),
  ).toThrow();
});
test("equivalent public key encodings have the same fingerprint", async () => {
  const keys = await generateVapidKeys();
  expect(vapidKeyFingerprint(keys.publicKey + "=")).toBe(vapidKeyFingerprint(keys.publicKey));
});
test.each([
  "mailto:@example.com",
  "mailto:a@localhost.",
  "https://localhost./contact",
  "mailto:a@localhost?subject=x",
  "mailto:a@example.com\nWEB_PUSH_TEST_MODE=true",
])("rejects malformed contact URI %j", (subject) => {
  expect(validateVapidSubject(subject)).not.toBeNull();
});
test("key generation translates WebCrypto rejection", async () => {
  vi.spyOn(crypto.subtle, "generateKey").mockRejectedValue(new Error("unsupported"));
  await expect(generateVapidKeys()).rejects.toMatchObject({
    data: { code: "WEB_PUSH_CRYPTO_UNSUPPORTED" },
  });
});
test("CLI quotes a contact URI containing shell metacharacters", async () => {
  const subject = "https://example.com/contact?x=1&y=2";
  const result = await runCli(["generate-keys", "--subject", subject]);
  expect(result.stdout).toContain("VAPID_SUBJECT '" + subject + "'");
  expect(result.stdout).toContain("VAPID_PUBLIC_KEY '<value>'");
  expect(result.stdout).toContain("VAPID_PRIVATE_KEY '<value>'");
});
test("push failures cancel response bodies without reading or retaining them", async () => {
  const { subscription } = await makeSubscription();
  const keys = await generateVapidKeys();
  const cancel = vi.fn();
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(1024));
      if (pulls === 2048) controller.close();
    },
    cancel,
  });
  vi.stubGlobal("fetch", async () => new Response(body, { status: 410 }));
  const outcome = await sendWebPush({
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    payload: null,
    ttl: 60,
    urgency: "normal",
    vapid: {
      publicKey: keys.publicKey,
      subject: "mailto:ops@example.com",
      privateKey: await importVapidPrivateKey(keys.publicKey, keys.privateKey),
    },
  });
  expect(cancel).toHaveBeenCalled();
  expect(pulls).toBeLessThanOrEqual(1);
  expect(JSON.stringify(outcome)).not.toContain(subscription.endpoint);
});
