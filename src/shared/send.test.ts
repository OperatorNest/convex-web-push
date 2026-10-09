import { afterEach, expect, test, vi } from "vitest";
import { base64urlEncode, bytesEqual } from "./base64url.js";
import { sendWebPush, type SendWebPushInput } from "./send.js";
import { generateVapidKeys, importVapidPrivateKey, verifyVapidJwt } from "./vapid.js";
import { decryptAes128gcm, makeSubscription } from "../test-helpers.js";

afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const { subscription, uaPublic, authSecret, uaPrivate } = await makeSubscription();
  const keys = await generateVapidKeys();
  const input: SendWebPushInput = {
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    payload: new TextEncoder().encode('{"title":"hi"}'),
    ttl: 600,
    urgency: "high",
    topic: "unread",
    vapid: {
      publicKey: keys.publicKey,
      subject: "mailto:ops@example.com",
      privateKey: await importVapidPrivateKey(keys.publicKey, keys.privateKey),
    },
  };
  return { input, keys, uaPublic, authSecret, uaPrivate };
}

function stubFetch(respond: (init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (_url: URL, init: RequestInit) => respond(init));
  vi.stubGlobal("fetch", mock);
  return {
    mock,
    request() {
      const call = mock.mock.calls[0];
      if (!call) throw new Error("fetch was not called");
      return { url: call[0], init: call[1] };
    },
  };
}

test("posts an encrypted, signed message with the protocol headers", async () => {
  const { input, keys, uaPublic, authSecret, uaPrivate } = await setup();
  const fetched = stubFetch(() => new Response(null, { status: 201 }));

  expect(await sendWebPush(input)).toEqual({ kind: "sent", statusCode: 201 });

  const { url, init } = fetched.request();
  expect(String(url)).toBe(input.endpoint);
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
    sub: "mailto:ops@example.com",
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
  const fetched = stubFetch(() => new Response(null, { status: 201 }));
  await sendWebPush({ ...input, payload: null });
  const { init } = fetched.request();
  expect(init.body).toBeNull();
  expect(new Headers(init.headers).has("Content-Encoding")).toBe(false);
});

test("never calls fetch for an endpoint outside the allowlist", async () => {
  const { input } = await setup();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const outcome = await sendWebPush({ ...input, endpoint: "https://evil.example.com/x" });
  expect(outcome).toMatchObject({ kind: "permanent", errorKind: "endpoint_not_allowed" });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("classifies responses and keeps a truncated body", async () => {
  const { input } = await setup();
  vi.stubGlobal("fetch", async () => new Response("x".repeat(500), { status: 410 }));
  const gone = await sendWebPush(input);
  expect(gone).toMatchObject({ kind: "gone", statusCode: 410 });
  expect(gone.detail).toHaveLength(200);

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
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const outcome = await sendWebPush({ ...input, p256dh: base64urlEncode(new Uint8Array(10)) });
  expect(outcome).toMatchObject({ kind: "permanent", errorKind: "invalid_subscription" });
  expect(fetchMock).not.toHaveBeenCalled();
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
  expect(await sendWebPush(input)).toEqual({ kind: "sent", statusCode: 201 });
  expect(cancelled).toBe(true);
});
