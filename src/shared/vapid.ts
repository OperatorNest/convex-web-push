import { base64urlDecode, base64urlEncode, utf8Encode } from "./base64url.js";
import { webPushError } from "./errors.js";
import { sha256 } from "./sha256.js";

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/** Apple rejects tokens whose exp is more than 24h away. Twelve hours leaves room for clock skew. */
const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/** A VAPID key pair identifies the application server signing push messages. */
export type VapidKeys = { publicKey: string; privateKey: string };

/** Generate a new P-256 key pair for VAPID application server identification. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  try {
    const pair = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    if (!jwk.d) throw webPushError("WEB_PUSH_CRYPTO_UNSUPPORTED");
    return { publicKey: base64urlEncode(publicKey), privateKey: jwk.d };
  } catch {
    throw webPushError("WEB_PUSH_CRYPTO_UNSUPPORTED");
  }
}

type Parsed = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; problem: string };

const number = (part: Uint8Array) => part.reduce((value, byte) => (value << 8n) + BigInt(byte), 0n);

// Convex mutations cannot await WebCrypto; this checks the public P-256 curve equation.
export function isP256PublicKey(bytes: Uint8Array): boolean {
  if (bytes.byteLength !== 65 || bytes[0] !== 4) return false;
  const x = number(bytes.slice(1, 33));
  const y = number(bytes.slice(33));
  const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  const b = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
  return x < p && y < p && (y * y - x * x * x + 3n * x - b) % p === 0n;
}

export function parsePublicKey(publicKey: string): Parsed {
  if (publicKey.length > 88) return { ok: false, problem: "WEB_PUSH_VAPID_PUBLIC_KEY is too long" };
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64urlDecode(publicKey);
  } catch {
    return { ok: false, problem: "WEB_PUSH_VAPID_PUBLIC_KEY is not valid base64url" };
  }
  if (!isP256PublicKey(bytes)) {
    return { ok: false, problem: "WEB_PUSH_VAPID_PUBLIC_KEY must be a 65-byte uncompressed point" };
  }
  return { ok: true, bytes };
}

export function parsePrivateKey(privateKey: string): Parsed {
  if (privateKey.length > 44)
    return { ok: false, problem: "WEB_PUSH_VAPID_PRIVATE_KEY must decode to exactly 32 bytes" };
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64urlDecode(privateKey);
  } catch {
    return { ok: false, problem: "WEB_PUSH_VAPID_PRIVATE_KEY is not valid base64url" };
  }
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  if (bytes.byteLength !== 32 || number(bytes) === 0n || number(bytes) >= order) {
    return { ok: false, problem: "WEB_PUSH_VAPID_PRIVATE_KEY must decode to exactly 32 bytes" };
  }
  return { ok: true, bytes };
}

function parseOrThrow(parsed: Parsed): Uint8Array<ArrayBuffer> {
  if (!parsed.ok) throw webPushError("WEB_PUSH_NOT_CONFIGURED");
  return parsed.bytes;
}

export async function importVapidPrivateKey(
  publicKey: string,
  privateKey: string,
): Promise<CryptoKey> {
  const pub = parseOrThrow(parsePublicKey(publicKey));
  const d = parseOrThrow(parsePrivateKey(privateKey));
  try {
    const privateCryptoKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        d: base64urlEncode(d),
        x: base64urlEncode(pub.slice(1, 33)),
        y: base64urlEncode(pub.slice(33, 65)),
      },
      ECDSA,
      false,
      ["sign"],
    );
    const publicCryptoKey = await importVapidPublicKey(publicKey);
    const probe = utf8Encode("convex-web-push VAPID key-pair verification");
    const signature = await crypto.subtle.sign(SIGN, privateCryptoKey, probe);
    if (!(await crypto.subtle.verify(SIGN, publicCryptoKey, signature, probe)))
      throw webPushError("WEB_PUSH_NOT_CONFIGURED");
    return privateCryptoKey;
  } catch {
    throw webPushError("WEB_PUSH_NOT_CONFIGURED");
  }
}

function importVapidPublicKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", parseOrThrow(parsePublicKey(publicKey)), ECDSA, false, [
    "verify",
  ]);
}

const RESERVED_HOST = /(^|\.)(localhost|local|invalid|test)$/i;

export function validateVapidSubject(subject: string | undefined): string | null {
  if (!subject) return "WEB_PUSH_VAPID_SUBJECT is not set";
  const invalid =
    "WEB_PUSH_VAPID_SUBJECT must be a control-free mailto address or HTTPS contact URL on a non-reserved host";
  if (subject.length > 2048 || /[\p{Cc}\p{Z}]/u.test(subject)) return invalid;
  try {
    const uri = new URL(subject);
    if (uri.protocol === "mailto:") {
      const address = decodeURIComponent(uri.pathname);
      const parts = address.split("@");
      const [local, host] = parts;
      if (parts.length !== 2 || !local || !host || /[\p{Cc}\p{Z},<>]/u.test(address))
        return invalid;
      const domain = new URL("https://" + host);
      if (
        domain.hostname !== host.toLowerCase() ||
        domain.pathname !== "/" ||
        domain.search ||
        domain.hash ||
        domain.port ||
        domain.username ||
        domain.password ||
        RESERVED_HOST.test(domain.hostname.replace(/\.$/, ""))
      )
        return invalid;
      return null;
    }
    if (
      uri.protocol !== "https:" ||
      !uri.hostname ||
      uri.username ||
      uri.password ||
      RESERVED_HOST.test(uri.hostname.replace(/\.$/, ""))
    )
      return invalid;
    return null;
  } catch {
    return invalid;
  }
}

export function vapidKeyFingerprint(publicKey: string | undefined): string {
  if (!publicKey) return "none";
  const bytes = parseOrThrow(parsePublicKey(publicKey));
  return Array.from(sha256(bytes).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

type SignVapidJwtInput = {
  audience: string;
  subject: string;
  privateKey: CryptoKey;

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

export function vapidAuthorization(jwt: string, publicKey: string): string {
  return `vapid t=${jwt}, k=${publicKey}`;
}

/** A verified VAPID token exposes its signed header and audience, expiry and subject claims. */
export type VerifiedVapidJwt = {
  header: Record<string, unknown>;
  claims: { aud?: string | undefined; exp?: number | undefined; sub?: string | undefined };
};

function decodeJsonPart(part: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(base64urlDecode(part)));
  if (typeof parsed !== "object" || parsed === null) throw new Error("JWT part is not an object");
  return Object.fromEntries(Object.entries(parsed));
}

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
