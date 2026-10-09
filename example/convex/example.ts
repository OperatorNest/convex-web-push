import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { vWebPushSubscription, WebPush } from "@operatornest/convex-web-push";
import { components, internal } from "./_generated/api.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";

// The public surface. A browser may only act on its own subscriptions and notify itself, and
// `userId` always comes from `ctx.auth`, never from an argument. Anything that names another user
// (broadcasts, notifying someone else, raw payloads) is internal: see admin.ts.

const webPush = new WebPush(components.webPush);

async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not signed in");
  return identity.subject;
}

export const publicKey = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: (ctx) => webPush.getPublicKey(ctx),
});

export const saveSubscription = mutation({
  args: { subscription: vWebPushSubscription, userAgent: v.optional(v.string()) },
  returns: v.object({ subscriptionId: v.string(), created: v.boolean() }),
  handler: async (ctx, args) =>
    webPush.recordSubscription(ctx, { userId: await requireUserId(ctx), ...args }),
});

export const removeSubscription = mutation({
  args: { endpoint: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { endpoint }) =>
    // Passing userId means a leaked endpoint cannot remove someone else's subscription.
    webPush.removeSubscription(ctx, { endpoint, userId: await requireUserId(ctx) }),
});

/** A user can notify themselves, for example to test their own setup. Nobody else. */
export const notifyMe = mutation({
  args: { title: v.string(), body: v.optional(v.string()), url: v.optional(v.string()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, notification): Promise<string | null> =>
    webPush.sendNotification(ctx, {
      userId: await requireUserId(ctx),
      notification,
      options: { onComplete: internal.results.onNotificationComplete },
    }),
});

export const myStatus = query({
  args: {},
  returns: v.object({
    subscriptions: v.number(),
    paused: v.number(),
    lastSuccessAt: v.optional(v.number()),
  }),
  handler: async (ctx) => webPush.getStatusForUser(ctx, { userId: await requireUserId(ctx) }),
});

export const myNotifications = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({ id: v.string(), payload: v.string(), status: v.string(), createdAt: v.number() }),
  ),
  handler: async (ctx, { paginationOpts }) => {
    const result = await webPush.getNotificationsForUser(ctx, {
      userId: await requireUserId(ctx),
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
  handler: async (ctx) => webPush.pauseNotifications(ctx, { userId: await requireUserId(ctx) }),
});

export const resumeMine = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => webPush.resumeNotifications(ctx, { userId: await requireUserId(ctx) }),
});
