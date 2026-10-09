import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { isSendOutcome, MAX_ERROR_DETAIL_CHARS, planRetry } from "../shared/classify.js";
import { vSendOutcome, type SendOutcome, vUrgency } from "../shared/validators.js";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, query } from "./_generated/server.js";
import { deliveryPool } from "./pool.js";
import schema from "./schema.js";

const skip = (outcome: SendOutcome) => ({ ok: false as const, outcome });

const CLOSED = new Set<Doc<"deliveries">["status"]>(["sent", "failed", "gone"]);
const isClosed = (status: Doc<"deliveries">["status"]) => CLOSED.has(status);

const vBeginResult = v.union(
  v.object({ ok: v.literal(false), outcome: vSendOutcome }),
  v.object({
    ok: v.literal(true),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    vapidPublicKeyHash: v.string(),
    payload: v.string(),
    payloadEncoding: v.optional(v.literal("base64url")),
    ttl: v.number(),
    urgency: vUrgency,
    topic: v.optional(v.string()),
    testMode: v.optional(v.boolean()),
    allowedPushHosts: v.optional(v.array(v.string())),
  }),
);

/** Loads everything `deliver.run` needs and marks the delivery as sending. */
export const begin = internalMutation({
  args: { deliveryId: v.id("deliveries") },
  returns: vBeginResult,
  handler: async (ctx, { deliveryId }) => {
    const delivery = await ctx.db.get("deliveries", deliveryId);
    if (!delivery || isClosed(delivery.status)) {
      return skip({ kind: "permanent", errorKind: "delivery_closed" });
    }
    const notification = await ctx.db.get("notifications", delivery.notificationId);
    if (!notification) return skip({ kind: "permanent", errorKind: "notification_missing" });
    const subscription = await ctx.db.get("subscriptions", delivery.subscriptionId);
    if (!subscription) return skip({ kind: "gone", errorKind: "subscription_removed" });
    const now = Date.now();
    if (subscription.userId !== delivery.userId) {
      return skip({ kind: "permanent", errorKind: "reassigned" });
    }
    if (subscription.status === "gone")
      return skip({ kind: "gone", errorKind: "subscription_gone" });
    if (subscription.expirationTime !== undefined && subscription.expirationTime <= now) {
      return skip({ kind: "gone", errorKind: "subscription_expired" });
    }
    if (subscription.status !== "active") {
      return skip({ kind: "permanent", errorKind: "subscription_paused" });
    }
    // TTL 0 means deliver now or drop: one attempt, never retried. Otherwise send what is left.
    const ttl = notification.options.ttl;
    const remaining = Math.floor((notification.createdAt + ttl * 1000 - now) / 1000);
    if (ttl > 0 && remaining <= 0) return skip({ kind: "permanent", errorKind: "ttl_expired" });
    if (ttl === 0 && delivery.attempts > 0) {
      return skip({ kind: "permanent", errorKind: "ttl_expired" });
    }
    await ctx.db.patch("deliveries", deliveryId, { status: "sending" });
    return {
      ok: true as const,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      vapidPublicKeyHash: subscription.vapidPublicKeyHash,
      payload: notification.payload,
      ttl: ttl === 0 ? 0 : remaining,
      urgency: notification.options.urgency,
      ...(notification.options.topic !== undefined && { topic: notification.options.topic }),
      ...(notification.payloadEncoding !== undefined && {
        payloadEncoding: notification.payloadEncoding,
      }),
      ...(notification.testMode !== undefined && { testMode: notification.testMode }),
      ...(notification.allowedPushHosts !== undefined && {
        allowedPushHosts: notification.allowedPushHosts,
      }),
    };
  },
});

export const onComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ deliveryId: v.id("deliveries") })),
  returns: v.null(),
  handler: async (ctx, { context, result }) => {
    const delivery = await ctx.db.get("deliveries", context.deliveryId);
    if (!delivery || isClosed(delivery.status)) return null;

    let outcome: SendOutcome;
    if (result.kind === "success") {
      outcome = isSendOutcome(result.returnValue)
        ? result.returnValue
        : { kind: "retryable", errorKind: "invalid_result" };
    } else if (result.kind === "failed") {
      outcome = {
        kind: "retryable",
        errorKind: "action_failed",
        detail: result.error.slice(0, MAX_ERROR_DETAIL_CHARS),
      };
    } else outcome = { kind: "permanent", errorKind: "canceled" };

    const now = Date.now();
    const notification = await ctx.db.get("notifications", delivery.notificationId);
    const attempts = delivery.attempts + 1;
    // Patching a field with `undefined` removes it, so each attempt replaces the previous record.
    const record = {
      attempts,
      statusCode: outcome.statusCode,
      errorKind: outcome.errorKind,
      detail: outcome.detail?.slice(0, MAX_ERROR_DETAIL_CHARS),
      retryAfterMs: outcome.retryAfterMs,
    };

    let finalStatus: "sent" | "failed" | "gone" = "failed";
    let errorKind = outcome.errorKind;
    if (outcome.kind === "retryable" && notification) {
      const plan = planRetry({
        attempts,
        now,
        createdAt: notification.createdAt,
        ttlSeconds: notification.options.ttl,
        retryAfterMs: outcome.retryAfterMs,
        random: Math.random(),
      });
      if (plan.retry) {
        await ctx.db.patch("deliveries", delivery._id, { ...record, status: "retry" });
        await deliveryPool().enqueueAction(
          ctx,
          internal.deliver.run,
          { deliveryId: delivery._id },
          {
            onComplete: internal.deliveries.onComplete,
            context: { deliveryId: delivery._id },
            runAfter: plan.delayMs,
          },
        );
        return null;
      }
      errorKind = plan.reason;
    } else if (outcome.kind === "sent") finalStatus = "sent";
    else if (outcome.kind === "gone") finalStatus = "gone";

    await ctx.db.patch("deliveries", delivery._id, {
      ...record,
      errorKind: finalStatus === "sent" ? undefined : errorKind,
      status: finalStatus,
      sentAt: finalStatus === "sent" ? now : undefined,
    });

    const subscription = await ctx.db.get("subscriptions", delivery.subscriptionId);
    // A subscription that moved to another user is no longer ours to update.
    if (subscription && subscription.userId === delivery.userId) {
      if (finalStatus === "sent") {
        await ctx.db.patch("subscriptions", subscription._id, {
          lastSuccessAt: now,
          consecutiveFailures: 0,
        });
      } else {
        await ctx.db.patch("subscriptions", subscription._id, {
          lastFailureAt: now,
          consecutiveFailures: subscription.consecutiveFailures + 1,
          ...(finalStatus === "gone" ? { status: "gone" as const, updatedAt: now } : {}),
        });
      }
    }

    if (notification) {
      const counts = {
        ...notification.counts,
        queued: Math.max(0, notification.counts.queued - 1),
      };
      counts[finalStatus] += 1;
      const settled = counts.sent + counts.failed + counts.gone;
      if (counts.queued > 0) {
        await ctx.db.patch("notifications", notification._id, {
          counts,
          status: settled === 0 ? "queued" : "partial",
        });
        return null;
      }
      const status = counts.sent > 0 ? "delivered" : "failed";
      // A definitively failed send releases its idempotency key, so a retry with the same key
      // (for example after the user re-subscribes) sends instead of returning this failure.
      await ctx.db.patch("notifications", notification._id, {
        counts,
        status,
        ...(status === "failed" && { idempotencyKey: undefined }),
      });
      if (notification.onComplete) {
        await ctx.scheduler.runAfter(0, internal.notifications.invokeCallback, {
          handle: notification.onComplete,
          notificationId: notification._id,
          userId: notification.userId,
          status,
          counts,
        });
      }
    }
    return null;
  },
});

export const listForNotification = query({
  args: { notificationId: v.id("notifications") },
  returns: v.array(schema.doc("deliveries")),
  handler: (ctx, { notificationId }) =>
    ctx.db
      .query("deliveries")
      .withIndex("by_notification", (q) => q.eq("notificationId", notificationId))
      .take(100),
});
