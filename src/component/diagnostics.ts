import { v } from "convex/values";
import { base64urlDecode, base64urlEncode, bytesEqual, utf8Encode } from "../shared/base64url.js";
import { encryptAes128gcmWithFixedKeys } from "../shared/encrypt.js";
import { sha256Hex } from "../shared/sha256.js";
import { RFC8291_VECTOR } from "../shared/vectors.js";
import { MAX_ERROR_DETAIL_CHARS } from "../shared/classify.js";
import { isTestMode } from "../shared/config.js";
import {
  generateVapidKeys,
  importVapidPrivateKey,
  readVapidConfig,
  signVapidJwt,
  verifyVapidJwt,
} from "../shared/vapid.js";
import { action, env } from "./_generated/server.js";

const vCheck = v.object({ name: v.string(), ok: v.boolean(), error: v.optional(v.string()) });

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    return { name, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, ok: false, error: message.slice(0, MAX_ERROR_DETAIL_CHARS) };
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Exercises every WebCrypto operation the pipeline needs inside the real Convex runtime. Run it
 * once after deploying. Reports per-operation success; never returns key material.
 */
export const selfTest = action({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    testMode: v.boolean(),
    /** Whether the VAPID env is complete and well formed. `problem` never contains key material. */
    config: v.object({ configured: v.boolean(), problem: v.optional(v.string()) }),
    checks: v.array(vCheck),
  }),
  handler: async () => {
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

    const config = readVapidConfig(env);
    if (config.ok) {
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
            "VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY",
          );
        }),
      );
    }
    return {
      ok: checks.every((c) => c.ok),
      testMode: isTestMode(undefined, env.WEB_PUSH_TEST_MODE),
      config: config.ok ? { configured: true } : { configured: false, problem: config.problem },
      checks,
    };
  },
});
