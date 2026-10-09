import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { expect, vi } from "vitest";
import { base64urlEncode, concatBytes, utf8Encode } from "./shared/base64url.js";
import { isWebPushError, type WebPushErrorCode } from "./shared/errors.js";
import { generateVapidKeys } from "./shared/vapid.js";
import schema from "./component/schema.js";

/** Component modules for convex-test, without any test files. */
const modules = import.meta.glob(["./component/**/*.ts", "!./component/**/*.test.ts"]);

export type SetupOptions = {
  /** Records sends without calling a push service. On unless you pass false. */
  testMode?: boolean;
};

/** Registers the component and its workpool. Pass `testMode: false` to exercise real sending. */
export function setupTest(options: SetupOptions = {}) {
  if (options.testMode !== false) vi.stubEnv("WEB_PUSH_TEST_MODE", "true");
  const t = convexTest(schema, modules);
  registerWorkpool(t, "workpool");
  return t;
}

export type TestCtx = ReturnType<typeof setupTest>;

/** Real test-only VAPID keys, with test mode off. Never use production credentials in tests. */
export async function configureVapid(subject = "mailto:ops@example.com") {
  const keys = await generateVapidKeys();
  vi.stubEnv("VAPID_PUBLIC_KEY", keys.publicKey);
  vi.stubEnv("VAPID_PRIVATE_KEY", keys.privateKey);
  vi.stubEnv("VAPID_SUBJECT", subject);
  vi.stubEnv("WEB_PUSH_TEST_MODE", undefined);
  return keys;
}

/** A browser subscription with fresh P-256 and auth material, plus the keys to decrypt pushes. */
export async function makeSubscription(host = "fcm.googleapis.com", path = "/fcm/send/") {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    subscription: {
      endpoint: `https://${host}${path}${crypto.randomUUID()}`,
      expirationTime: null,
      keys: { p256dh: base64urlEncode(uaPublic), auth: base64urlEncode(authSecret) },
    },
    uaPrivate: pair.privateKey,
    uaPublic,
    authSecret,
  };
}

export async function drain(t: {
  finishAllScheduledFunctions(advanceTimers: () => void): Promise<void>;
}) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function hkdf(secret: Uint8Array, salt: Uint8Array, info: Uint8Array, bits: number) {
  const key = await crypto.subtle.importKey("raw", secret.slice(), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt.slice(), info: info.slice() },
      key,
      bits,
    ),
  );
}

/** Independent RFC 8291 receiver used to check what the sender produced. */
export async function decryptAes128gcm(
  body: Uint8Array,
  uaPrivate: CryptoKey,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const idLength = body[20] ?? 0;
  const asPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const asKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivate, 256),
  );
  const ikm = await hkdf(
    ecdh,
    authSecret,
    concatBytes(utf8Encode("WebPush: info\0"), uaPublic, asPublic),
    256,
  );
  const cek = await hkdf(ikm, salt, utf8Encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, salt, utf8Encode("Content-Encoding: nonce\0"), 96);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, ciphertext),
  );
  let end = record.length;
  while (end > 0 && record[end - 1] === 0) end--;
  if (record[end - 1] !== 2) throw new Error("missing record delimiter");
  return record.slice(0, end - 1);
}

/** Narrows a value the test knows exists, with a clear failure instead of a non-null assertion. */
export function required<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to exist`);
  return value;
}

/** Replaces `fetch`. Each call uses the next responder, repeating the last one. */
export function stubFetch(...responders: (() => Response | Promise<Response>)[]) {
  let call = 0;
  const calls: { time: number; url: URL; init: RequestInit }[] = [];
  const mock = vi.fn(async (url: URL, init: RequestInit) => {
    calls.push({ time: Date.now(), url, init });
    const responder = required(responders[Math.min(call++, responders.length - 1)], "a responder");
    return responder();
  });
  vi.stubGlobal("fetch", mock);
  return {
    mock,
    calls,
    /** Request headers of call `n`, with case-insensitive lookup. */
    headers: (n = 0) => new Headers(required(calls[n], `fetch call ${n}`).init.headers),
    /** Request body of call `n` as bytes, or null for a bodyless push. */
    body(n = 0) {
      const body = required(calls[n], `fetch call ${n}`).init.body;
      return body instanceof Uint8Array ? body : null;
    },
  };
}

/** A fake push service answer: 201 has no body, anything else says no. */
export const respond = (status: number, headers?: Record<string, string>) => () =>
  new Response(status === 201 ? null : "push service says no", {
    status,
    ...(headers !== undefined && { headers }),
  });

/** Asserts the promise rejects with a Web Push error carrying exactly this code. */
export async function expectWebPushError(promise: Promise<unknown>, code: WebPushErrorCode) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isWebPushError(error), String(error)).toBe(true);
  if (isWebPushError(error)) expect(error.data.code).toBe(code);
}
