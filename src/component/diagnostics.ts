import { v } from "convex/values";
import { base64urlDecode, base64urlEncode, bytesEqual, utf8Encode } from "../shared/base64url.js";
import { encryptAes128gcmWithFixedKeys } from "../shared/encrypt.js";
import { sha256Hex } from "../shared/sha256.js";
import { RFC8291_VECTOR } from "../shared/vectors.js";
import { webPushError } from "../shared/errors.js";
import { readConfig, requireVapidConfig, isTestMode } from "../shared/config.js";
import {
  generateVapidKeys,
  importVapidPrivateKey,
  signVapidJwt,
  verifyVapidJwt,
} from "../shared/vapid.js";
import { env, type ActionCtx } from "./_generated/server.js";

const vCheck = v.object({ name: v.string(), ok: v.boolean(), error: v.optional(v.string()) });

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    return { name, ok: true };
  } catch {
    return { name, ok: false, error: webPushError("WEB_PUSH_CRYPTO_UNSUPPORTED").data.message };
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export const verificationDefinition = {
  args: { testMode: v.optional(v.boolean()) },
  returns: v.object({
    ok: v.boolean(),
    testMode: v.boolean(),

    config: v.object({ configured: v.boolean(), problem: v.optional(v.string()) }),
    checks: v.array(vCheck),
  }),
  handler: async (_ctx: ActionCtx, args: { testMode?: boolean }) => {
    const parsed = readConfig(env);
    const testMode = isTestMode(args.testMode, parsed.testMode);
    if (!testMode) requireVapidConfig(parsed);
    const config =
      parsed.publicKey !== undefined &&
      parsed.privateKey !== undefined &&
      parsed.subject !== undefined
        ? requireVapidConfig(parsed)
        : undefined;
    const checks = [
      await check("sha256 digest", async () => {
        const digest = await crypto.subtle.digest("SHA-256", utf8Encode("abc"));
        assert(base64urlEncode(new Uint8Array(digest)).length === 43, "unexpected digest size");
        assert(sha256Hex("abc").startsWith("ba7816bf"), "sync sha256 mismatch");
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
        assert(bytesEqual(new Uint8Array(ab), new Uint8Array(ba)), "ECDH secrets differ");
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
        assert(
          bytesEqual(body, base64urlDecode(RFC8291_VECTOR.body)),
          "encrypted body differs from the RFC",
        );
      }),
      await check("VAPID ES256 sign and verify", async () => {
        const keys = await generateVapidKeys();
        const key = await importVapidPrivateKey(keys.publicKey, keys.privateKey);
        const jwt = await signVapidJwt({
          audience: "https://push.example.com",
          subject: "mailto:test@example.com",
          privateKey: key,
        });
        assert((await verifyVapidJwt(jwt, keys.publicKey)) !== null, "signature did not verify");
      }),
    ];

    if (config) {
      const { publicKey, privateKey } = config;
      checks.push(
        await check("configured VAPID key pair matches", async () => {
          const key = await importVapidPrivateKey(publicKey, privateKey);
          const jwt = await signVapidJwt({
            audience: "https://push.example.com",
            subject: "mailto:test@example.com",
            privateKey: key,
          });
          assert(
            (await verifyVapidJwt(jwt, publicKey)) !== null,
            "WEB_PUSH_VAPID_PUBLIC_KEY does not match WEB_PUSH_VAPID_PRIVATE_KEY",
          );
        }),
      );
    }
    return {
      ok: checks.every((c) => c.ok),
      testMode,
      config: config
        ? { configured: true }
        : {
            configured: false,
            problem: webPushError("WEB_PUSH_NOT_CONFIGURED").data.message,
          },
      checks,
    };
  },
};
