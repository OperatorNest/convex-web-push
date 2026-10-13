import { v } from "convex/values";
import { base64urlDecode, base64urlEncode, bytesEqual, utf8Encode } from "../shared/base64url.js";
import { encryptAes128gcmWithFixedKeys } from "../shared/encrypt.js";
import { isWebPushError, webPushError } from "../shared/errors.js";
import { readConfig, requireVapidConfig, resolveTestMode } from "../shared/config.js";
import { sha256Hex } from "../shared/sha256.js";
import {
  generateVapidKeys,
  importVapidPrivateKey,
  signVapidJwt,
  verifyVapidJwt,
} from "../shared/vapid.js";
import { RFC8291_VECTOR } from "../shared/vectors.js";
import { action, env, query } from "./_generated/server.js";

const configCheckValidator = v.object({
  name: v.string(),
  ok: v.boolean(),
  error: v.optional(v.string()),
});

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    return { name, ok: true };
  } catch (error) {
    const failure = isWebPushError(error) ? error : webPushError("WEB_PUSH_CRYPTO_UNSUPPORTED");
    return { name, ok: false, error: failure.data.message };
  }
}

function requireCrypto(condition: boolean): asserts condition {
  if (!condition) throw webPushError("WEB_PUSH_CRYPTO_UNSUPPORTED");
}

export const get = query({
  args: { testMode: v.optional(v.boolean()) },
  returns: v.object({ applicationServerKey: v.union(v.string(), v.null()) }),
  handler: (_ctx, args) => {
    const config = readConfig(env);
    if (!resolveTestMode(args.testMode, env)) requireVapidConfig(config);
    return { applicationServerKey: config.publicKey ?? null };
  },
});

export const verify = action({
  args: { testMode: v.optional(v.boolean()) },
  returns: v.object({
    ok: v.boolean(),
    testMode: v.boolean(),
    config: v.object({ configured: v.boolean(), problem: v.optional(v.string()) }),
    checks: v.array(configCheckValidator),
  }),
  handler: async (_ctx, args) => {
    const parsed = readConfig(env);
    const testMode = resolveTestMode(args.testMode, env);
    if (!testMode) requireVapidConfig(parsed);
    const configured =
      parsed.publicKey !== undefined &&
      parsed.privateKey !== undefined &&
      parsed.subject !== undefined;
    if (parsed.publicKey !== undefined && parsed.privateKey !== undefined)
      await importVapidPrivateKey(parsed.publicKey, parsed.privateKey);
    const checks = [
      await check("sha256 digest", async () => {
        const digest = await crypto.subtle.digest("SHA-256", utf8Encode("abc"));
        requireCrypto(base64urlEncode(new Uint8Array(digest)).length === 43);
        requireCrypto(sha256Hex("abc").startsWith("ba7816bf"));
      }),
      await check("ECDH P-256 key agreement", async () => {
        const params = { name: "ECDH", namedCurve: "P-256" } as const;
        const a = await crypto.subtle.generateKey(params, true, ["deriveBits"]);
        const b = await crypto.subtle.generateKey(params, true, ["deriveBits"]);
        const ab = await crypto.subtle.deriveBits(
          { name: "ECDH", public: b.publicKey },
          a.privateKey,
          256,
        );
        const ba = await crypto.subtle.deriveBits(
          { name: "ECDH", public: a.publicKey },
          b.privateKey,
          256,
        );
        requireCrypto(bytesEqual(new Uint8Array(ab), new Uint8Array(ba)));
      }),
      await check("RFC 8291 Appendix A vector", async () => {
        const body = await encryptAes128gcmWithFixedKeys(
          {
            plaintext: base64urlDecode(RFC8291_VECTOR.plaintext),
            uaPublic: base64urlDecode(RFC8291_VECTOR.uaPublic),
            authSecret: base64urlDecode(RFC8291_VECTOR.authSecret),
          },
          {
            ephemeral: {
              privateKeyD: base64urlDecode(RFC8291_VECTOR.asPrivate),
              publicKey: base64urlDecode(RFC8291_VECTOR.asPublic),
            },
            salt: base64urlDecode(RFC8291_VECTOR.salt),
          },
        );
        requireCrypto(bytesEqual(body, base64urlDecode(RFC8291_VECTOR.body)));
      }),
      await check("VAPID ES256 sign and verify", async () => {
        const keys = await generateVapidKeys();
        const key = await importVapidPrivateKey(keys.publicKey, keys.privateKey);
        const jwt = await signVapidJwt({
          audience: "https://push.example.com",
          subject: "mailto:test@example.com",
          privateKey: key,
        });
        requireCrypto((await verifyVapidJwt(jwt, keys.publicKey)) !== null);
      }),
    ];
    return {
      ok: checks.every((c) => c.ok),
      testMode,
      config: configured
        ? { configured: true }
        : { configured: false, problem: webPushError("WEB_PUSH_NOT_CONFIGURED").data.message },
      checks,
    };
  },
});
