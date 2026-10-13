import {
  deliveryErrorKindValidator,
  webPushBatchCompleteArgsValidator,
  webPushNotificationCompleteArgsValidator,
  pushSubscriptionValidator,
  WebPush,
} from "@operatornest/convex-web-push";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";

const webPush = new WebPush(components.webPush, {
  onNotificationComplete: internal.results.onNotificationComplete,
  onBatchComplete: internal.results.onBatchComplete,
});
const webPushTest = new WebPush(components.webPush, { testMode: true });

const countsValidator = v.object({
  queued: v.number(),
  sent: v.number(),
  failed: v.number(),
  gone: v.number(),
});

const urgencyValidator = v.union(
  v.literal("very-low"),
  v.literal("low"),
  v.literal("normal"),
  v.literal("high"),
);

const notificationSummaryValidator = v.object({
  notificationId: v.string(),
  payload: v.string(),
  options: v.object({ ttlSeconds: v.number(), urgency: v.string(), topic: v.optional(v.string()) }),
  status: v.string(),
  counts: countsValidator,
  testMode: v.boolean(),
  createdAt: v.number(),
});

export const recordSubscription = internalMutation({
  args: {
    userId: v.string(),
    subscription: pushSubscriptionValidator,
    userAgent: v.optional(v.string()),
  },
  returns: v.object({ subscriptionId: v.string(), created: v.boolean() }),
  handler: (ctx, args) => webPush.subscriptions.record(ctx, args),
});

export const removeSubscription = internalMutation({
  args: { endpoint: v.string(), userId: v.string() },
  returns: v.boolean(),
  handler: (ctx, args) => webPush.subscriptions.remove(ctx, args),
});

export const removeAll = internalMutation({
  args: { userId: v.string() },
  returns: v.object({ removed: v.number(), done: v.boolean() }),
  handler: (ctx, args) => webPush.subscriptions.removeAll(ctx, args),
});

export const sendNotification = internalMutation({
  args: {
    userId: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    url: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    ttlSeconds: v.optional(v.number()),
    urgency: v.optional(urgencyValidator),
    topic: v.optional(v.string()),
  },
  returns: v.union(v.string(), v.null()),
  handler: (
    ctx,
    { userId, idempotencyKey, ttlSeconds, urgency, topic, ...notification },
  ): Promise<string | null> =>
    webPush.notifications.send(ctx, {
      userId,
      notification,
      idempotencyKey,
      ttlSeconds: ttlSeconds ?? 86400,
      urgency: urgency ?? "normal",
      topic,
    }),
});

export const sendTestNotification = internalMutation({
  args: { userId: v.string(), title: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, { userId, title }) =>
    webPushTest.notifications.send(ctx, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId,
      notification: { title },
    }),
});

export const sendRawNotification = internalMutation({
  args: { userId: v.string(), payload: v.union(v.string(), v.bytes()) },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, { userId, payload }) =>
    webPush.notifications.sendRaw(ctx, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId,
      payload: typeof payload === "string" ? payload : new Uint8Array(payload),
    }),
});

export const sendBatch = internalMutation({
  args: { userIds: v.array(v.string()), title: v.string(), body: v.optional(v.string()) },
  returns: v.object({
    batchId: v.string(),
    results: v.array(
      v.object({ userId: v.string(), notificationId: v.union(v.string(), v.null()) }),
    ),
    done: v.boolean(),
  }),
  handler: (ctx, { userIds, ...notification }): ReturnType<WebPush["notifications"]["sendBatch"]> =>
    webPush.notifications.sendBatch(ctx, {
      ttlSeconds: 86400,
      urgency: "normal",
      userIds,
      notification,
    }),
});

export const getBatch = internalQuery({
  args: { batchId: v.string() },
  returns: v.object({
    status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    errorCode: webPushBatchCompleteArgsValidator.fields.errorCode,
    total: v.number(),
    processed: v.number(),
    notificationIds: v.array(v.string()),
  }),
  handler: (ctx, args) => webPush.notifications.getBatch(ctx, args),
});

type NotificationRow = Awaited<ReturnType<WebPush["notifications"]["list"]>>["page"][number];

function summarize(n: NotificationRow) {
  return {
    notificationId: n._id,
    payload: n.payload,
    options: n.options,
    status: n.status,
    counts: n.counts,
    createdAt: n.createdAt,
    testMode: n.testMode,
  };
}

export const listNotifications = internalQuery({
  args: { userId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(notificationSummaryValidator),
  handler: async (ctx, args) => {
    const result = await webPush.notifications.list(ctx, args);
    return { ...result, page: result.page.map(summarize) };
  },
});

export const getNotification = internalQuery({
  args: { notificationId: v.string(), userId: v.string() },
  returns: notificationSummaryValidator,
  handler: async (ctx, args) => {
    const n = await webPush.notifications.get(ctx, args);
    return summarize(n);
  },
});

type DeliveryRow = Awaited<ReturnType<WebPush["deliveries"]["list"]>>[number];

function summarizeDelivery(d: DeliveryRow) {
  return {
    status: d.status,
    attempts: d.attempts,
    ...(d.errorKind !== undefined && { errorKind: d.errorKind }),
  };
}

export const listDeliveries = internalQuery({
  args: { notificationId: v.string(), userId: v.string() },
  returns: v.array(
    v.object({
      status: v.string(),
      attempts: v.number(),
      errorKind: v.optional(deliveryErrorKindValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await webPush.deliveries.list(ctx, args);
    return rows.map(summarizeDelivery);
  },
});

export const listNotificationResults = internalQuery({
  args: { userId: v.string(), testMode: v.boolean() },
  returns: v.array(
    v.object({
      notificationId: v.string(),
      status: webPushNotificationCompleteArgsValidator.fields.status,
      sent: v.number(),
      failed: v.number(),
      gone: v.number(),
    }),
  ),
  handler: async (ctx, { userId, testMode }) => {
    const rows = await ctx.db
      .query("notificationResults")
      .withIndex("by_userId_and_testMode", (q) => q.eq("userId", userId).eq("testMode", testMode))
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

export const getSubscriptionStatus = internalQuery({
  args: { userId: v.string() },
  returns: v.object({
    activeCount: v.number(),
    pausedCount: v.number(),
    lastSuccessAt: v.optional(v.number()),
  }),
  handler: (ctx, args) => webPush.subscriptions.getStatus(ctx, args),
});

export const pauseSubscriptions = internalMutation({
  args: { userId: v.string() },
  returns: v.number(),
  handler: (ctx, args) => webPush.subscriptions.pause(ctx, args),
});

export const resumeSubscriptions = internalMutation({
  args: { userId: v.string() },
  returns: v.number(),
  handler: (ctx, args) => webPush.subscriptions.resume(ctx, args),
});

export const verifyConfig = internalAction({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    testMode: v.boolean(),
    config: v.object({ configured: v.boolean(), problem: v.optional(v.string()) }),
    checks: v.array(v.object({ name: v.string(), ok: v.boolean(), error: v.optional(v.string()) })),
  }),
  handler: (ctx) => webPush.config.verify(ctx),
});
