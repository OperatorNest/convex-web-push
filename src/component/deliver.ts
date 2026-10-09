import { v } from "convex/values";
import { base64urlDecode } from "../shared/base64url.js";
import { readVapidConfig, importVapidPrivateKey, vapidKeyFingerprint } from "../shared/vapid.js";
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
    if (job.testMode === true) return { kind: "sent", statusCode: 0 };

    const config = readVapidConfig(env);
    if (!config.ok) {
      return { kind: "permanent", errorKind: "vapid_not_configured", detail: config.problem };
    }
    if (
      job.vapidPublicKeyHash !== "none" &&
      job.vapidPublicKeyHash !== vapidKeyFingerprint(config.publicKey)
    ) {
      return {
        kind: "gone",
        errorKind: "vapid_key_mismatch",
        detail: "Subscription was created under a different VAPID key",
      };
    }

    let signingKey: CryptoKey;
    try {
      signingKey = await importVapidPrivateKey(config.publicKey, config.privateKey);
    } catch {
      return {
        kind: "permanent",
        errorKind: "invalid_vapid_key",
        detail: "VAPID key pair could not be imported",
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
      ttl: job.ttl,
      urgency: job.urgency,
      topic: job.topic,
      allowedPushHosts: job.allowedPushHosts,
      vapid: { publicKey: config.publicKey, subject: config.subject, privateKey: signingKey },
    });
  },
});
