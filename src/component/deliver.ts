import { readConfig, requireVapidConfig } from "../shared/config.js";
import { webPushError } from "../shared/errors.js";
import { v } from "convex/values";
import { base64urlDecode } from "../shared/base64url.js";
import { importVapidPrivateKey, vapidKeyFingerprint } from "../shared/vapid.js";
import { sendWebPush } from "../shared/send.js";
import { vSendOutcome, type SendOutcome } from "../shared/validators.js";
import { internal } from "./_generated/api.js";
import { env, internalAction } from "./_generated/server.js";

export const run = internalAction({
  args: { deliveryId: v.id("deliveries") },
  returns: vSendOutcome,
  handler: async (ctx, { deliveryId }): Promise<SendOutcome> => {
    const job = await ctx.runMutation(internal.deliveries.begin, { deliveryId });
    if (!job.ok) return job.outcome;
    let config;
    try {
      const parsed = readConfig(env);
      if (job.testMode === true) return { kind: "sent" };
      config = requireVapidConfig(parsed);
    } catch {
      return {
        kind: "permanent",
        errorKind: "vapid_not_configured",
        error: webPushError("WEB_PUSH_NOT_CONFIGURED").data,
      };
    }
    if (
      job.vapidPublicKeyHash !== "none" &&
      job.vapidPublicKeyHash !== vapidKeyFingerprint(config.publicKey)
    ) {
      return {
        kind: "gone",
        errorKind: "vapid_key_mismatch",
        error: webPushError("WEB_PUSH_NOT_CONFIGURED").data,
      };
    }

    let signingKey: CryptoKey;
    try {
      signingKey = await importVapidPrivateKey(config.publicKey, config.privateKey);
    } catch {
      return {
        kind: "permanent",
        errorKind: "invalid_vapid_key",
        error: webPushError("WEB_PUSH_NOT_CONFIGURED").data,
      };
    }

    let payload: Uint8Array | null = null;
    if (job.payload !== "") {
      payload =
        job.payloadEncoding === "base64url"
          ? base64urlDecode(job.payload)
          : new TextEncoder().encode(job.payload);
    }
    return sendWebPush({
      endpoint: job.endpoint,
      p256dh: job.p256dh,
      auth: job.auth,
      payload,
      ttlSeconds: job.ttlSeconds,
      urgency: job.urgency,
      topic: job.topic,
      allowedPushHosts: job.allowedPushHosts,
      vapid: { publicKey: config.publicKey, subject: config.subject, privateKey: signingKey },
    });
  },
});
