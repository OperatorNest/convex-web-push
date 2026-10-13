import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { vWebPushSubscription, WebPush } from "@operatornest/convex-web-push";
import { components, internal } from "./_generated/api.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";

const webPush = new WebPush(components.webPush);

async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not signed in");
  return identity.tokenIdentifier;
}

export const publicKey = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    await requireUserId(ctx);
    return webPush.getPublicKey(ctx);
  },
});

export const saveSubscription = mutation({
  args: { subscription: vWebPushSubscription, userAgent: v.optional(v.string()) },
  returns: v.object({ subscriptionId: v.string(), created: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return webPush.recordSubscription(ctx, {
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
    return webPush.removeSubscription(ctx, { endpoint, userId });
  },
});

export const notifyMe = mutation({
  args: { title: v.string(), body: v.optional(v.string()), url: v.optional(v.string()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, notification): Promise<string | null> => {
    const userId = await requireUserId(ctx);
    return webPush.sendNotification(ctx, {
      userId,
      notification,
      options: { onComplete: internal.results.onNotificationComplete },
    });
  },
});

export const myStatus = query({
  args: {},
  returns: v.object({
    subscriptions: v.number(),
    paused: v.number(),
    lastSuccessAt: v.optional(v.number()),
  }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    return webPush.getStatusForUser(ctx, { userId });
  },
});

export const myNotifications = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({ id: v.string(), payload: v.string(), status: v.string(), createdAt: v.number() }),
  ),
  handler: async (ctx, { paginationOpts }) => {
    const userId = await requireUserId(ctx);
    const result = await webPush.getNotificationsForUser(ctx, {
      userId,
      paginationOpts,
    });
    return {
      ...result,
      page: result.page.map((n) => ({
        id: n._id,
        payload: n.payload,
        status: n.status,
        createdAt: n.createdAt,
      })),
    };
  },
});

export const pauseMine = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    return webPush.pauseNotifications(ctx, { userId });
  },
});

export const resumeMine = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    return webPush.resumeNotifications(ctx, { userId });
  },
});

export const myNotification = query({
  args: { notificationId: v.string() },
  returns: v.union(v.object({ payload: v.string(), status: v.string() }), v.null()),
  handler: async (ctx, { notificationId }) => {
    const userId = await requireUserId(ctx);
    const notification = await webPush.getNotification(ctx, { notificationId, userId });
    return notification ? { payload: notification.payload, status: notification.status } : null;
  },
});

export const myDeliveries = query({
  args: { notificationId: v.string() },
  returns: v.array(v.object({ status: v.string(), attempts: v.number() })),
  handler: async (ctx, { notificationId }) => {
    const userId = await requireUserId(ctx);
    const deliveries = await webPush.getDeliveries(ctx, { notificationId, userId });
    return deliveries.map(({ status, attempts }) => ({ status, attempts }));
  },
});
