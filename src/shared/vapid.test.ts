import { readConfig } from "./config.js";
import { expect, test, vi, afterEach } from "vitest";
import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { isWebPushError } from "./errors.js";
import {
  generateVapidKeys,
  importVapidPrivateKey,
  signVapidJwt,
  validateVapidSubject,
  vapidAuthorization,
  vapidKeyFingerprint,
  verifyVapidJwt,
} from "./vapid.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("generates a 65-byte public key and a 32-byte private scalar", async () => {
  const keys = await generateVapidKeys();
  const pub = base64urlDecode(keys.publicKey);
  expect(pub.byteLength).toBe(65);
  expect(pub[0]).toBe(4);
  expect(base64urlDecode(keys.privateKey).byteLength).toBe(32);
  expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
  expect((await generateVapidKeys()).privateKey).not.toBe(keys.privateKey);
});

test("signs an ES256 JWT that verifies with the public key", async () => {
  const keys = await generateVapidKeys();
  const key = await importVapidPrivateKey(keys.publicKey, keys.privateKey);
  const now = Date.UTC(2026, 9, 4, 12, 0, 0);
  const jwt = await signVapidJwt({
    audience: "https://fcm.googleapis.com",
    subject: "mailto:ops@example.com",
    privateKey: key,
    now,
  });
  const [header, , signature] = jwt.split(".") as [string, string, string];
  expect(base64urlDecode(signature).byteLength).toBe(64);
  expect(JSON.parse(new TextDecoder().decode(base64urlDecode(header)))).toEqual({
    typ: "JWT",
    alg: "ES256",
  });
  const verified = await verifyVapidJwt(jwt, keys.publicKey);
  expect(verified?.claims.aud).toBe("https://fcm.googleapis.com");
  expect(verified?.claims.sub).toBe("mailto:ops@example.com");
  const exp = verified!.claims.exp!;
  expect(exp).toBeGreaterThan(now / 1000);
  expect(exp - now / 1000).toBeLessThanOrEqual(24 * 60 * 60);
});

test("rejects a tampered token and a different key", async () => {
  const keys = await generateVapidKeys();
  const other = await generateVapidKeys();
  const key = await importVapidPrivateKey(keys.publicKey, keys.privateKey);
  const jwt = await signVapidJwt({
    audience: "https://a.example",
    subject: "mailto:a@example.com",
    privateKey: key,
  });
  expect(await verifyVapidJwt(jwt, other.publicKey)).toBeNull();
  const [h, , s] = jwt.split(".") as [string, string, string];
  const forged = base64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({ aud: "https://evil.example", exp: 9e9, sub: "mailto:a@example.com" }),
    ),
  );
  expect(await verifyVapidJwt(`${h}.${forged}.${s}`, keys.publicKey)).toBeNull();
  expect(await verifyVapidJwt("not-a-jwt", keys.publicKey)).toBeNull();
});

test("rejects a private scalar with a missing byte", async () => {
  const keys = await generateVapidKeys();
  const short = base64urlEncode(base64urlDecode(keys.privateKey).slice(1));
  await expect(importVapidPrivateKey(keys.publicKey, short)).rejects.toMatchObject({
    data: { code: "WEB_PUSH_NOT_CONFIGURED" },
  });
});

test("rejects malformed keys without echoing them", async () => {
  const keys = await generateVapidKeys();
  await expect(importVapidPrivateKey("short", keys.privateKey)).rejects.toMatchObject({
    data: { code: "WEB_PUSH_NOT_CONFIGURED" },
  });
  const secret = base64urlEncode(new Uint8Array(40).fill(9));
  const error = await importVapidPrivateKey(keys.publicKey, secret).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isWebPushError(error)).toBe(true);
  expect(String(error)).not.toContain(secret);
});

test("the key fingerprint is short, stable and says none when unset", async () => {
  const keys = await generateVapidKeys();
  expect(vapidKeyFingerprint(keys.publicKey)).toMatch(/^[0-9a-f]{16}$/);
  expect(vapidKeyFingerprint(keys.publicKey)).toBe(vapidKeyFingerprint(keys.publicKey));
  expect(vapidKeyFingerprint(undefined)).toBe("none");
});

test("generateVapidKeys fails with a typed error when WebCrypto hides the scalar", async () => {
  const exportKey = vi.spyOn(crypto.subtle, "exportKey").mockResolvedValue({ kty: "EC" });
  try {
    await expect(generateVapidKeys()).rejects.toMatchObject({
      data: { code: "WEB_PUSH_CRYPTO_UNSUPPORTED" },
    });
  } finally {
    exportKey.mockRestore();
  }
});

test("builds the vapid Authorization header", () => {
  expect(vapidAuthorization("a.b.c", "KEY")).toBe("vapid t=a.b.c, k=KEY");
});

test("validates the subject the way Apple does", () => {
  expect(validateVapidSubject("mailto:ops@example.com")).toBeNull();
  expect(validateVapidSubject("https://example.com/contact")).toBeNull();
  expect(validateVapidSubject(undefined)).not.toBeNull();
  expect(validateVapidSubject("ops@example.com")).not.toBeNull();
  expect(validateVapidSubject("mailto:ops")).not.toBeNull();
  expect(validateVapidSubject("mailto:ops@corp.local")).not.toBeNull();
  expect(validateVapidSubject("https://localhost:3000")).not.toBeNull();
  expect(validateVapidSubject("mailto:a@site.invalid")).not.toBeNull();
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

test.each([1, 31])("VAPID rejects a %s-byte private scalar", async (size) => {
  const keys = await generateVapidKeys();
  const privateKey = base64urlEncode(new Uint8Array(size).fill(1));
  expect(() =>
    readConfig({
      WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
      WEB_PUSH_VAPID_PRIVATE_KEY: privateKey,
      WEB_PUSH_VAPID_SUBJECT: "mailto:ops@example.com",
    }),
  ).toThrow();
  await expect(importVapidPrivateKey(keys.publicKey, privateKey)).rejects.toMatchObject({
    data: { code: "WEB_PUSH_NOT_CONFIGURED" },
  });
});
