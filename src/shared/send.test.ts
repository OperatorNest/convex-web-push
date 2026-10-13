import { afterEach, expect, test, vi } from "vitest";
import { base64urlEncode, bytesEqual } from "./base64url.js";
import { sendWebPush, type SendWebPushInput } from "./send.js";
import { generateVapidKeys, importVapidPrivateKey, verifyVapidJwt } from "./vapid.js";
import { decryptAes128gcm, makeSubscription, required, stubFetch } from "../test-helpers.js";

afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const { subscription, uaPublic, authSecret, uaPrivate } = await makeSubscription();
  const keys = await generateVapidKeys();
  const input: SendWebPushInput = {
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    payload: new TextEncoder().encode('{"title":"hi"}'),
    ttlSeconds: 600,
    urgency: "high",
    topic: "unread",
    vapid: {
      publicKey: keys.publicKey,
      subject: "mailto:ops@acme.dev",
      privateKey: await importVapidPrivateKey(keys.publicKey, keys.privateKey),
    },
  };
  return { input, keys, uaPublic, authSecret, uaPrivate };
}

test("posts an encrypted, signed message with the protocol headers", async () => {
  const { input, keys, uaPublic, authSecret, uaPrivate } = await setup();
  const calls = stubFetch(() => new Response(null, { status: 201 }));

  expect(await sendWebPush(input)).toEqual({ kind: "sent", providerStatus: 201, attempted: true });

  const { url, init } = required(calls[0], "the push request");
  expect(url).toBe(input.endpoint);
  expect(init.method).toBe("POST");
  expect(init.redirect).toBe("manual");
  const headers = new Headers(init.headers);
  expect(Object.fromEntries(headers)).toMatchObject({
    ttl: "600",
    urgency: "high",
    topic: "unread",
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
  });
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(headers.get("Authorization") ?? "");
  expect(match?.[2]).toBe(keys.publicKey);
  const verified = await verifyVapidJwt(match?.[1] ?? "", keys.publicKey);
  expect(verified?.claims).toMatchObject({
    aud: "https://fcm.googleapis.com",
    sub: "mailto:ops@acme.dev",
  });
  expect(init.body).toBeInstanceOf(Uint8Array);
  const plaintext = await decryptAes128gcm(
    init.body instanceof Uint8Array ? init.body : new Uint8Array(),
    uaPrivate,
    uaPublic,
    authSecret,
  );
  expect(bytesEqual(plaintext, new TextEncoder().encode('{"title":"hi"}'))).toBe(true);
});

test("an empty payload sends no body and no Content-Encoding", async () => {
  const { input } = await setup();
  const calls = stubFetch(() => new Response(null, { status: 201 }));
  await sendWebPush({ ...input, payload: null });
  const { init } = required(calls[0], "the push request");
  expect(init.body).toBeNull();
  expect(new Headers(init.headers).has("Content-Encoding")).toBe(false);
});

test("never calls fetch for an endpoint outside the allowlist", async () => {
  const { input } = await setup();
  const calls = stubFetch(() => new Response(null, { status: 201 }));
  const outcome = await sendWebPush({ ...input, endpoint: "https://evil.example.com/x" });
  expect(outcome).toMatchObject({ kind: "permanent", errorKind: "endpoint_not_allowed" });
  expect(calls).toHaveLength(0);
});

test("classifies responses without retaining their bodies", async () => {
  const { input } = await setup();
  vi.stubGlobal("fetch", async () => new Response("x".repeat(500), { status: 410 }));
  const gone = await sendWebPush(input);
  expect(gone).toMatchObject({ kind: "gone", providerStatus: 410 });
  expect(gone.error).toMatchObject({ code: "WEB_PUSH_PROVIDER_ERROR", providerStatus: 410 });

  vi.stubGlobal(
    "fetch",
    async () => new Response("slow down", { status: 429, headers: { "Retry-After": "45" } }),
  );
  expect(await sendWebPush(input)).toMatchObject({ kind: "retryable", retryAfterMs: 45_000 });
});

test("network errors and timeouts are retryable", async () => {
  const { input } = await setup();
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("connection reset");
  });
  expect(await sendWebPush(input)).toMatchObject({ kind: "retryable", errorKind: "network_error" });

  vi.stubGlobal("setTimeout", (callback: () => void) => {
    queueMicrotask(callback);
    return 0;
  });
  vi.stubGlobal("clearTimeout", () => {});
  vi.stubGlobal(
    "fetch",
    (_url: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  expect(await sendWebPush(input)).toMatchObject({ kind: "retryable", errorKind: "timeout" });
});

test("invalid subscription keys are a permanent failure without a network call", async () => {
  const { input } = await setup();
  const calls = stubFetch(() => new Response(null, { status: 201 }));
  const outcome = await sendWebPush({ ...input, p256dh: base64urlEncode(new Uint8Array(10)) });
  expect(outcome).toMatchObject({ kind: "permanent", errorKind: "invalid_subscription_keys" });
  expect(calls).toHaveLength(0);
});

test("a successful response body is cancelled, not left open", async () => {
  const { input } = await setup();
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  stubFetch(() => new Response(body, { status: 201 }));
  expect(await sendWebPush(input)).toEqual({ kind: "sent", providerStatus: 201, attempted: true });
  expect(cancelled).toBe(true);
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
    ttlSeconds: 60,
    urgency: "normal",
    vapid: {
      publicKey: keys.publicKey,
      subject: "mailto:ops@acme.dev",
      privateKey: await importVapidPrivateKey(keys.publicKey, keys.privateKey),
    },
  });
  expect(cancel).toHaveBeenCalled();
  expect(pulls).toBeLessThanOrEqual(1);
  expect(JSON.stringify(outcome)).not.toContain(subscription.endpoint);
});
