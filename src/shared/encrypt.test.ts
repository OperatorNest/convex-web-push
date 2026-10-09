import { expect, test } from "vitest";
import { base64urlDecode, base64urlEncode, bytesEqual } from "./base64url.js";
import { encryptAes128gcm, encryptAes128gcmWithFixedKeys, MAX_PLAINTEXT_BYTES } from "./encrypt.js";
import { isWebPushError } from "./errors.js";
import { RFC8291_VECTOR as V } from "./vectors.js";
import { decryptAes128gcm, makeSubscription } from "../test-helpers.js";

const fixed = {
  ephemeral: { privateKeyD: base64urlDecode(V.asPrivate), publicKey: base64urlDecode(V.asPublic) },
  salt: base64urlDecode(V.salt),
};
const input = {
  plaintext: base64urlDecode(V.plaintext),
  uaPublic: base64urlDecode(V.uaPublic),
  authSecret: base64urlDecode(V.authSecret),
};

test("reproduces the RFC 8291 Appendix A body byte for byte", async () => {
  const body = await encryptAes128gcmWithFixedKeys(input, fixed);
  const expected = base64urlDecode(V.body);
  expect(expected.byteLength).toBe(144);
  expect(body.byteLength).toBe(144);
  expect(bytesEqual(body, expected)).toBe(true);
});

test("the RFC header is salt, rs=4096, idlen=65 and the ephemeral key", async () => {
  const body = await encryptAes128gcmWithFixedKeys(input, fixed);
  expect(base64urlEncode(body.slice(0, 16))).toBe(V.salt);
  expect(Array.from(body.slice(16, 21))).toEqual([0, 0, 16, 0, 65]);
  expect(base64urlEncode(body.slice(21, 86))).toBe(V.asPublic);
});

async function subscriber() {
  const { uaPrivate, uaPublic, authSecret } = await makeSubscription();
  return { uaPrivate, uaPublic, authSecret };
}

test("round-trips with an independent receiver and a random ephemeral key", async () => {
  const sub = await subscriber();
  const plaintext = new TextEncoder().encode('{"title":"héllo"}');
  const body = await encryptAes128gcm({ plaintext, ...sub });
  expect(body.byteLength).toBe(86 + plaintext.byteLength + 1 + 16);
  const decrypted = await decryptAes128gcm(body, sub.uaPrivate, sub.uaPublic, sub.authSecret);
  expect(bytesEqual(decrypted, plaintext)).toBe(true);
});

test("uses a fresh ephemeral key and salt for every message", async () => {
  const sub = await subscriber();
  const plaintext = new Uint8Array([1, 2, 3]);
  const a = await encryptAes128gcm({ plaintext, ...sub });
  const b = await encryptAes128gcm({ plaintext, ...sub });
  expect(bytesEqual(a.slice(0, 16), b.slice(0, 16))).toBe(false);
  expect(bytesEqual(a.slice(21, 86), b.slice(21, 86))).toBe(false);
});

test("accepts exactly the maximum payload and rejects one byte more", async () => {
  const sub = await subscriber();
  const max = new Uint8Array(MAX_PLAINTEXT_BYTES).fill(97);
  const body = await encryptAes128gcm({ plaintext: max, ...sub });
  expect(body.byteLength).toBe(4096);
  const decrypted = await decryptAes128gcm(body, sub.uaPrivate, sub.uaPublic, sub.authSecret);
  expect(decrypted.byteLength).toBe(MAX_PLAINTEXT_BYTES);
  await expect(
    encryptAes128gcm({ plaintext: new Uint8Array(MAX_PLAINTEXT_BYTES + 1), ...sub }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_PAYLOAD_TOO_LARGE" } });
});

test("rejects malformed subscriber keys", async () => {
  const sub = await subscriber();
  const plaintext = new Uint8Array([1]);
  await expect(
    encryptAes128gcm({ plaintext, ...sub, uaPublic: sub.uaPublic.slice(0, 64) }),
  ).rejects.toSatisfy(isWebPushError);
  const wrongPrefix = sub.uaPublic.slice();
  wrongPrefix[0] = 2;
  await expect(
    encryptAes128gcm({ plaintext, ...sub, uaPublic: wrongPrefix }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_INVALID_SUBSCRIPTION" } });
  await expect(
    encryptAes128gcm({ plaintext, ...sub, authSecret: new Uint8Array(15) }),
  ).rejects.toMatchObject({ data: { code: "WEB_PUSH_INVALID_SUBSCRIPTION" } });
});
