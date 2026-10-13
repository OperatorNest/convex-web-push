import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { expect, vi } from "vitest";
import schema from "./component/schema.js";
import { isWebPushError, type WebPushErrorCode } from "./shared/errors.js";
import { base64urlEncode, concatBytes, utf8Encode } from "./shared/base64url.js";
import { generateVapidKeys } from "./shared/vapid.js";

// shared-block:begin
type GlobImportMeta = ImportMeta & {
  glob: (patterns: string[]) => Record<string, () => Promise<unknown>>;
};
const modules = (import.meta as GlobImportMeta).glob([
  "./component/**/*.ts",
  "!./component/**/*.test.ts",
]);

export function setupTest() {
  const t = convexTest(schema, modules);
  registerWorkpool(t, "workpool");
  return t;
}

export type TestCtx = ReturnType<typeof setupTest>;

export async function drain(t: Pick<TestCtx, "finishAllScheduledFunctions">): Promise<void> {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

export function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to exist`);
  return value;
}

export type FetchCall = { url: string; init: RequestInit };

export function stubFetch(
  respond: (call: FetchCall, index: number) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: input instanceof Request ? input.url : String(input), init };
    calls.push(call);
    return respond(call, calls.length - 1);
  });
  return calls;
}

export async function expectWebPushError(
  promise: Promise<unknown>,
  code: WebPushErrorCode,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(isWebPushError(error), String(error)).toBe(true);
  if (isWebPushError(error)) expect(error.data.code).toBe(code);
}
// shared-block:end

export function setupSimulatedTest() {
  vi.stubEnv("WEB_PUSH_TEST_MODE", "true");
  return setupTest();
}

export function setupLiveTest() {
  vi.stubEnv("WEB_PUSH_TEST_MODE", "false");
  return setupTest();
}

export async function configureVapid(subject = "mailto:ops@acme.dev") {
  const keys = await generateVapidKeys();
  vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", keys.publicKey);
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", keys.privateKey);
  vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", subject);
  vi.stubEnv("WEB_PUSH_TEST_MODE", "false");
  return keys;
}

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

export const respond = (status: number, headers?: Record<string, string>) => () =>
  new Response(status === 201 ? null : "push pushService says no", {
    status,
    ...(headers !== undefined && { headers }),
  });

export function respondInOrder(...responders: (() => Response)[]) {
  return (_call: FetchCall, index: number) =>
    required(responders[Math.min(index, responders.length - 1)], "a responder")();
}

export function requestHeaders(calls: readonly FetchCall[], index = 0): Headers {
  return new Headers(required(calls[index], `fetch call ${index}`).init.headers);
}

export function requestBody(calls: readonly FetchCall[], index = 0): Uint8Array | null {
  const body = required(calls[index], `fetch call ${index}`).init.body;
  return body instanceof Uint8Array ? body : null;
}
