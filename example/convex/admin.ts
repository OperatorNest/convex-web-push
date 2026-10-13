import {
  vBatchResult,
  vNotificationResult,
  vWebPushSubscription,
  WebPush,
} from "@operatornest/convex-web-push";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";

const webPush = new WebPush(components.webPush);
const webPushTest = new WebPush(components.webPush, { testMode: true });

const vCounts = v.object({
  queued: v.number(),
  sent: v.number(),
  failed: v.number(),
  gone: v.number(),
});

const vUrgency = v.union(
  v.literal("very-low"),
  v.literal("low"),
  v.literal("normal"),
  v.literal("high"),
);

const vNotificationSummary = v.object({
  id: v.string(),
  payload: v.string(),
  options: v.object({ ttl: v.number(), urgency: v.string(), topic: v.optional(v.string()) }),
  status: v.string(),
  counts: vCounts,
  testMode: v.optional(v.boolean()),
  createdAt: v.number(),
});

export const saveSubscription = internalMutation({
  args: {
    userId: v.string(),
    subscription: vWebPushSubscription,
    userAgent: v.optional(v.string()),
  },
  returns: v.object({ subscriptionId: v.string(), created: v.boolean() }),
  handler: (ctx, args) => webPush.recordSubscription(ctx, args),
});

export const removeSubscription = internalMutation({
  args: { endpoint: v.string(), userId: v.string() },
  returns: v.boolean(),
  handler: (ctx, args) => webPush.removeSubscription(ctx, args),
});

export const removeAllForUser = internalMutation({
  args: { userId: v.string() },
  returns: v.object({ removed: v.number(), done: v.boolean() }),
  handler: (ctx, args) => webPush.removeAllForUser(ctx, args),
});

export const notify = internalMutation({
  args: {
    userId: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    url: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    ttl: v.optional(v.number()),
    urgency: v.optional(vUrgency),
    topic: v.optional(v.string()),
  },
  returns: v.union(v.string(), v.null()),
  handler: (
    ctx,
    { userId, idempotencyKey, ttl, urgency, topic, ...notification },
  ): Promise<string | null> =>
    webPush.sendNotification(ctx, {
      userId,
      notification,
      options: {
        idempotencyKey,
        ttl,
        urgency,
        topic,
        onComplete: internal.results.onNotificationComplete,
      },
    }),
});

export const notifyInTestMode = internalMutation({
  args: { userId: v.string(), title: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, { userId, title }) =>
    webPushTest.sendNotification(ctx, { userId, notification: { title } }),
});

export const notifyRaw = internalMutation({
  args: { userId: v.string(), payload: v.union(v.string(), v.bytes()) },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, { userId, payload }) =>
    webPush.sendRaw(ctx, {
      userId,
      payload: typeof payload === "string" ? payload : new Uint8Array(payload),
    }),
});

export const broadcast = internalMutation({
  args: { userIds: v.array(v.string()), title: v.string(), body: v.optional(v.string()) },
  returns: v.object({
    batchId: v.string(),
    results: v.array(
      v.object({ userId: v.string(), notificationId: v.union(v.string(), v.null()) }),
    ),
    done: v.boolean(),
  }),
  handler: (ctx, { userIds, ...notification }): ReturnType<WebPush["sendNotificationBatch"]> =>
    webPush.sendNotificationBatch(ctx, {
      userIds,
      notification,
      options: { onComplete: internal.results.onBatchComplete },
    }),
});

export const batchProgress = internalQuery({
  args: { batchId: v.string() },
  returns: v.union(
    v.object({
      status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
      errorCode: vBatchResult.fields.errorCode,
      total: v.number(),
      processed: v.number(),
      notificationIds: v.array(v.string()),
    }),
    v.null(),
  ),
  handler: (ctx, args) => webPush.getBatch(ctx, args),
});

type NotificationRow = Awaited<ReturnType<WebPush["getNotificationsForUser"]>>["page"][number];

function summarize(n: NotificationRow) {
  return {
    id: n._id,
    payload: n.payload,
    options: n.options,
    status: n.status,
    counts: n.counts,
    createdAt: n.createdAt,
    ...(n.testMode !== undefined && { testMode: n.testMode }),
  };
}

export const notifications = internalQuery({
  args: { userId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(vNotificationSummary),
  handler: async (ctx, args) => {
    const result = await webPush.getNotificationsForUser(ctx, args);
    return { ...result, page: result.page.map(summarize) };
  },
});

export const notification = internalQuery({
  args: { notificationId: v.string(), userId: v.string() },
  returns: v.union(vNotificationSummary, v.null()),
  handler: async (ctx, args) => {
    const n = await webPush.getNotification(ctx, args);
    return n ? summarize(n) : null;
  },
});

type DeliveryRow = Awaited<ReturnType<WebPush["getDeliveries"]>>[number];

function summarizeDelivery(d: DeliveryRow) {
  return {
    status: d.status,
    attempts: d.attempts,
    ...(d.errorKind !== undefined && { errorKind: d.errorKind }),
  };
}

export const deliveries = internalQuery({
  args: { notificationId: v.string(), userId: v.string() },
  returns: v.array(
    v.object({ status: v.string(), attempts: v.number(), errorKind: v.optional(v.string()) }),
  ),
  handler: async (ctx, args) => {
    const rows = await webPush.getDeliveries(ctx, args);
    return rows.map(summarizeDelivery);
  },
});

export const completedResults = internalQuery({
  args: { userId: v.string() },
  returns: v.array(
    v.object({
      notificationId: v.string(),
      status: vNotificationResult.fields.status,
      sent: v.number(),
      failed: v.number(),
      gone: v.number(),
    }),
  ),
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query("notificationResults")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(100);
    return rows.map(({ notificationId, status, sent, failed, gone }) => ({
      notificationId,
      status,
      sent,
      failed,
      gone,
    }));
  },
});

export const userStatus = internalQuery({
  args: { userId: v.string() },
  returns: v.object({
    subscriptions: v.number(),
    paused: v.number(),
    lastSuccessAt: v.optional(v.number()),
  }),
  handler: (ctx, args) => webPush.getStatusForUser(ctx, args),
});

export const pause = internalMutation({
  args: { userId: v.string() },
  returns: v.number(),
  handler: (ctx, args) => webPush.pauseNotifications(ctx, args),
});

export const resume = internalMutation({
  args: { userId: v.string() },
  returns: v.number(),
  handler: (ctx, args) => webPush.resumeNotifications(ctx, args),
});

export const selfTest = internalAction({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    testMode: v.boolean(),
    config: v.object({ configured: v.boolean(), problem: v.optional(v.string()) }),
    checks: v.array(v.object({ name: v.string(), ok: v.boolean(), error: v.optional(v.string()) })),
  }),
  handler: (ctx) => webPush.selfTest(ctx),
});
