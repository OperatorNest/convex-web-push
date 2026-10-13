import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { vPushSubscription, WebPush } from "@operatornest/convex-web-push";
import { components, internal } from "./_generated/api.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";

const webPush = new WebPush(components.webPush, {
  onNotificationComplete: internal.results.onNotificationComplete,
  onBatchComplete: internal.results.onBatchComplete,
});

async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not signed in");
  return identity.tokenIdentifier;
}

export const applicationServerKey = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    await requireUserId(ctx);
    return webPush.subscriptions.readApplicationServerKey(ctx, {});
  },
});

export const recordSubscription = mutation({
  args: { subscription: vPushSubscription, userAgent: v.optional(v.string()) },
  returns: v.object({ subscriptionId: v.string(), created: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return webPush.subscriptions.record(ctx, {
      userId,
      subscription: args.subscription,
      userAgent: args.userAgent,
    });
  },
});

export const removeSubscription = mutation({
  args: { endpoint: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { endpoint }) => {
    const userId = await requireUserId(ctx);
    return webPush.subscriptions.remove(ctx, { endpoint, userId });
  },
});

export const notifyMe = mutation({
  args: { title: v.string(), body: v.optional(v.string()), url: v.optional(v.string()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, notification): Promise<string | null> => {
    const userId = await requireUserId(ctx);
    return webPush.notifications.send(ctx, {
      ttlSeconds: 86400,
      urgency: "normal",
      userId,
      notification,
    });
  },
});

export const getMySubscriptionStatus = query({
  args: {},
  returns: v.object({
    subscriptions: v.number(),
    paused: v.number(),
    lastSuccessAt: v.optional(v.number()),
  }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    return webPush.subscriptions.getStatus(ctx, { userId });
  },
});

export const listMyNotifications = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      notificationId: v.string(),
      payload: v.string(),
      status: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, { paginationOpts }) => {
    const userId = await requireUserId(ctx);
    const result = await webPush.notifications.list(ctx, {
      userId,
      paginationOpts,
    });
    return {
      ...result,
      page: result.page.map((n) => ({
        notificationId: n._id,
        payload: n.payload,
        status: n.status,
        createdAt: n.createdAt,
      })),
    };
  },
});

export const pauseMySubscriptions = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    return webPush.subscriptions.pause(ctx, { userId });
  },
});

export const resumeMySubscriptions = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    return webPush.subscriptions.resume(ctx, { userId });
  },
});

export const getMyNotification = query({
  args: { notificationId: v.string() },
  returns: v.object({ payload: v.string(), status: v.string() }),
  handler: async (ctx, { notificationId }) => {
    const userId = await requireUserId(ctx);
    const notification = await webPush.notifications.get(ctx, { notificationId, userId });
    return { payload: notification.payload, status: notification.status };
  },
});

export const listMyDeliveries = query({
  args: { notificationId: v.string() },
  returns: v.array(v.object({ status: v.string(), attempts: v.number() })),
  handler: async (ctx, { notificationId }) => {
    const userId = await requireUserId(ctx);
    const deliveries = await webPush.deliveries.list(ctx, { notificationId, userId });
    return deliveries.map(({ status, attempts }) => ({ status, attempts }));
  },
});
