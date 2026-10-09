import { concatBytes, base64urlEncode, utf8Encode } from "./base64url.js";
import { webPushError } from "./errors.js";

/** RFC 8030 push services accept 4096-byte bodies: 4096 - 86 header - 1 delimiter - 16 tag. */
export const MAX_PLAINTEXT_BYTES = 3993;
const RECORD_SIZE = 4096;
const HEADER_BYTES = 86;

export type EncryptInput = {
  plaintext: Uint8Array;
  /** Subscriber `keys.p256dh`: 65-byte uncompressed P-256 point. */
  uaPublic: Uint8Array;
  /** Subscriber `keys.auth`: 16 bytes. */
  authSecret: Uint8Array;
};

/** Fixed ephemeral key and salt, used by `selfTest` and tests to reproduce RFC 8291 Appendix A. */
export type FixedKeyMaterial = {
  ephemeral: { privateKeyD: Uint8Array; publicKey: Uint8Array };
  salt: Uint8Array;
};

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

async function hkdf(
  secret: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bits: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const out = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    bits,
  );
  return new Uint8Array(out);
}

/** Encrypts `plaintext` into a single aes128gcm record (RFC 8291 + RFC 8188), ready to POST. */
export function encryptAes128gcm(input: EncryptInput): Promise<Uint8Array<ArrayBuffer>> {
  return encryptInternal(input, undefined);
}

/** Reproduces RFC 8291 Appendix A with caller-supplied key material. Sends use {@link encryptAes128gcm}. */
export function encryptAes128gcmWithFixedKeys(
  input: EncryptInput,
  fixed: FixedKeyMaterial,
): Promise<Uint8Array<ArrayBuffer>> {
  return encryptInternal(input, fixed);
}

async function encryptInternal(
  { plaintext, uaPublic, authSecret }: EncryptInput,
  fixed: FixedKeyMaterial | undefined,
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw webPushError(
      "WEB_PUSH_PAYLOAD_TOO_LARGE",
      `Payload is ${plaintext.byteLength} bytes; the maximum is ${MAX_PLAINTEXT_BYTES}`,
    );
  }
  if (uaPublic.byteLength !== 65 || uaPublic[0] !== 4) {
    throw webPushError(
      "WEB_PUSH_INVALID_SUBSCRIPTION",
      "p256dh must be a 65-byte uncompressed P-256 key",
    );
  }
  if (authSecret.byteLength !== 16) {
    throw webPushError("WEB_PUSH_INVALID_SUBSCRIPTION", "auth must be 16 bytes");
  }
  const recordLength = plaintext.byteLength + 1;

  const uaKey = await crypto.subtle.importKey("raw", uaPublic.slice(), ECDH, false, []);
  let privateKey: CryptoKey;
  let asPublic: Uint8Array<ArrayBuffer>;
  let salt: Uint8Array<ArrayBuffer>;
  if (fixed) {
    const pub = fixed.ephemeral.publicKey;
    privateKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        d: base64urlEncode(fixed.ephemeral.privateKeyD),
        x: base64urlEncode(pub.slice(1, 33)),
        y: base64urlEncode(pub.slice(33, 65)),
      },
      ECDH,
      false,
      ["deriveBits"],
    );
    asPublic = pub.slice();
    salt = fixed.salt.slice();
  } else {
    const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
    privateKey = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    salt = crypto.getRandomValues(new Uint8Array(16));
  }

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, privateKey, 256),
  );
  const keyInfo = concatBytes(utf8Encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(ecdhSecret, authSecret.slice(), keyInfo, 256);
  const cek = await hkdf(ikm, salt, utf8Encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, salt, utf8Encode("Content-Encoding: nonce\0"), 96);

  const record = new Uint8Array(recordLength);
  record.set(plaintext);
  record[plaintext.byteLength] = 2;
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record),
  );

  const header = new Uint8Array(HEADER_BYTES);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = asPublic.byteLength;
  header.set(asPublic, 21);
  return concatBytes(header, ciphertext);
}
