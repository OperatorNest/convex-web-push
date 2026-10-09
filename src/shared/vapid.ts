import { base64urlDecode, base64urlEncode, utf8Encode } from "./base64url.js";
import { webPushError } from "./errors.js";
import { sha256Hex } from "./sha256.js";

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/** Apple rejects tokens whose exp is more than 24h away. Twelve hours leaves room for clock skew. */
const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export type VapidKeys = { publicKey: string; privateKey: string };

/** Generates a VAPID key pair: 65-byte public point and 32-byte private scalar, both base64url. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  if (!jwk.d) {
    throw webPushError(
      "WEB_PUSH_CRYPTO_UNSUPPORTED",
      "WebCrypto did not export the private scalar",
    );
  }
  return { publicKey: base64urlEncode(publicKey), privateKey: jwk.d };
}

type Parsed = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; problem: string };

function parsePublicKey(publicKey: string): Parsed {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64urlDecode(publicKey);
  } catch {
    return { ok: false, problem: "VAPID_PUBLIC_KEY is not valid base64url" };
  }
  if (bytes.byteLength !== 65 || bytes[0] !== 4) {
    return { ok: false, problem: "VAPID_PUBLIC_KEY must be a 65-byte uncompressed point" };
  }
  return { ok: true, bytes };
}

function parsePrivateKey(privateKey: string): Parsed {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64urlDecode(privateKey);
  } catch {
    return { ok: false, problem: "VAPID_PRIVATE_KEY is not valid base64url" };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > 32) {
    return { ok: false, problem: "VAPID_PRIVATE_KEY must be a 32-byte scalar" };
  }
  return { ok: true, bytes };
}

function parseOrThrow(parsed: Parsed): Uint8Array<ArrayBuffer> {
  if (!parsed.ok) throw webPushError("WEB_PUSH_INVALID_VAPID_KEY", parsed.problem);
  return parsed.bytes;
}

/** Imports the signing key. WebCrypto cannot import a raw EC scalar, so this goes through JWK. */
export async function importVapidPrivateKey(
  publicKey: string,
  privateKey: string,
): Promise<CryptoKey> {
  const pub = parseOrThrow(parsePublicKey(publicKey));
  const d = parseOrThrow(parsePrivateKey(privateKey));
  const padded = new Uint8Array(32);
  padded.set(d, 32 - d.byteLength);
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: base64urlEncode(padded),
      x: base64urlEncode(pub.slice(1, 33)),
      y: base64urlEncode(pub.slice(33, 65)),
    },
    ECDSA,
    false,
    ["sign"],
  );
}

function importVapidPublicKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", parseOrThrow(parsePublicKey(publicKey)), ECDSA, false, [
    "verify",
  ]);
}

const RESERVED_HOST = /(^|\.)(localhost|local|invalid|test)$/i;

/** Returns an error message, or null when the subject is acceptable to Apple, FCM and Mozilla. */
export function validateVapidSubject(subject: string | undefined): string | null {
  if (!subject) return "VAPID_SUBJECT is not set";
  if (subject.startsWith("mailto:")) {
    const host = subject.slice(subject.lastIndexOf("@") + 1);
    if (!subject.includes("@") || !host || RESERVED_HOST.test(host)) {
      return "VAPID_SUBJECT mailto: must contain an address on a real domain";
    }
    return null;
  }
  if (subject.startsWith("https://")) {
    try {
      if (RESERVED_HOST.test(new URL(subject).hostname)) {
        return "VAPID_SUBJECT must not use a reserved host such as localhost";
      }
      return null;
    } catch {
      return "VAPID_SUBJECT is not a valid URL";
    }
  }
  return "VAPID_SUBJECT must start with mailto: or https://";
}

export type VapidEnv = {
  readonly VAPID_PUBLIC_KEY?: string | undefined;
  readonly VAPID_PRIVATE_KEY?: string | undefined;
  readonly VAPID_SUBJECT?: string | undefined;
};

export type VapidConfig =
  | { ok: true; publicKey: string; privateKey: string; subject: string }
  | { ok: false; problem: string };

/**
 * The one place VAPID settings are read and checked. It is synchronous so mutations can use it,
 * and the problem text never contains key material. A well-formed pair can still be mismatched;
 * `importVapidPrivateKey` catches that at send time.
 */
export function readVapidConfig(env: VapidEnv): VapidConfig {
  const {
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: privateKey,
    VAPID_SUBJECT: subject,
  } = env;
  if (!publicKey) return { ok: false, problem: "VAPID_PUBLIC_KEY is not set" };
  if (!privateKey) return { ok: false, problem: "VAPID_PRIVATE_KEY is not set" };
  const pub = parsePublicKey(publicKey);
  if (!pub.ok) return pub;
  const priv = parsePrivateKey(privateKey);
  if (!priv.ok) return priv;
  const subjectProblem = validateVapidSubject(subject);
  if (subjectProblem !== null || subject === undefined) {
    return { ok: false, problem: subjectProblem ?? "VAPID_SUBJECT is not set" };
  }
  return { ok: true, publicKey, privateKey, subject };
}

/** Short non-secret fingerprint of the public key, stored with each subscription. */
export function vapidKeyFingerprint(publicKey: string | undefined): string {
  return publicKey ? sha256Hex(publicKey).slice(0, 16) : "none";
}

type SignVapidJwtInput = {
  /** Origin of the push endpoint, for example `https://fcm.googleapis.com`. */
  audience: string;
  subject: string;
  privateKey: CryptoKey;
  /** Epoch milliseconds. Defaults to `Date.now()`. */
  now?: number | undefined;
  ttlSeconds?: number;
};

export async function signVapidJwt(input: SignVapidJwtInput): Promise<string> {
  const now = input.now ?? Date.now();
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: input.audience,
    exp: Math.floor(now / 1000) + (input.ttlSeconds ?? VAPID_TOKEN_TTL_SECONDS),
    sub: input.subject,
  };
  const signingInput = `${base64urlEncode(utf8Encode(JSON.stringify(header)))}.${base64urlEncode(
    utf8Encode(JSON.stringify(claims)),
  )}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(SIGN, input.privateKey, utf8Encode(signingInput)),
  );
  return `${signingInput}.${base64urlEncode(signature)}`;
}

/** `Authorization` header value per RFC 8292 section 3. */
export function vapidAuthorization(jwt: string, publicKey: string): string {
  return `vapid t=${jwt}, k=${publicKey}`;
}

export type VerifiedVapidJwt = {
  header: Record<string, unknown>;
  claims: { aud?: string | undefined; exp?: number | undefined; sub?: string | undefined };
};

function decodeJsonPart(part: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(base64urlDecode(part)));
  if (typeof parsed !== "object" || parsed === null) throw new Error("JWT part is not an object");
  return Object.fromEntries(Object.entries(parsed));
}

/** Verifies an ES256 JWT against a VAPID public key. Returns null when the signature is invalid. */
export async function verifyVapidJwt(
  jwt: string,
  publicKey: string,
): Promise<VerifiedVapidJwt | null> {
  const [headerPart, claimsPart, signaturePart, extra] = jwt.split(".");
  if (!headerPart || !claimsPart || !signaturePart || extra !== undefined) return null;
  try {
    const key = await importVapidPublicKey(publicKey);
    const valid = await crypto.subtle.verify(
      SIGN,
      key,
      base64urlDecode(signaturePart),
      utf8Encode(`${headerPart}.${claimsPart}`),
    );
    if (!valid) return null;
    const claims = decodeJsonPart(claimsPart);
    return {
      header: decodeJsonPart(headerPart),
      claims: {
        aud: typeof claims.aud === "string" ? claims.aud : undefined,
        exp: typeof claims.exp === "number" ? claims.exp : undefined,
        sub: typeof claims.sub === "string" ? claims.sub : undefined,
      },
    };
  } catch {
    return null;
  }
}
