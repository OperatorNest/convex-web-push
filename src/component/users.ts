import { v } from "convex/values";
import { boundedUtf8String } from "../shared/bounds.js";
import { resolveTestMode } from "../shared/config.js";
import { internal } from "./_generated/api.js";
import { env, internalMutation, mutation, type MutationCtx } from "./_generated/server.js";
import { PURGE_BATCH } from "./limits.js";
import { findOwner, generationIsCurrent, purgeResultValidator } from "./owners.js";

type PurgeScope = { userId: string; testMode: boolean; generation: number; before: number };

async function purgeSubscriptions(ctx: MutationCtx, scope: PurgeScope, limit: number) {
  const owner = await findOwner(ctx, scope.userId, scope.testMode);
  if (!generationIsCurrent(owner, scope.generation)) return 0;
  const rows = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId_and_testMode_and_generation", (q) =>
      q
        .eq("userId", scope.userId)
        .eq("testMode", scope.testMode)
        .lt("generation", scope.generation),
    )
    .take(limit);
  for (const row of rows) await ctx.db.delete("subscriptions", row._id);
  return rows.length;
}

async function purgeNotifications(ctx: MutationCtx, scope: PurgeScope, limit: number) {
  let removed = 0;
  while (removed < limit) {
    const notification = await ctx.db
      .query("notifications")
      .withIndex("by_userId_and_testMode_and_createdAt", (q) =>
        q.eq("userId", scope.userId).eq("testMode", scope.testMode).lte("createdAt", scope.before),
      )
      .first();
    if (!notification) break;
    const deliveries = await ctx.db
      .query("deliveries")
      .withIndex("by_notificationId", (q) => q.eq("notificationId", notification._id))
      .take(limit - removed);
    for (const row of deliveries) await ctx.db.delete("deliveries", row._id);
    removed += deliveries.length;
    if (removed === limit) break;
    await ctx.db.delete("notifications", notification._id);
    removed++;
  }
  return removed;
}

async function purgeStep(ctx: MutationCtx, scope: PurgeScope) {
  let removed = await purgeSubscriptions(ctx, scope, PURGE_BATCH);
  removed += await purgeNotifications(ctx, scope, PURGE_BATCH - removed);
  if (removed === PURGE_BATCH) {
    await ctx.scheduler.runAfter(0, internal.users.continuePurge, scope);
    return { removed, done: false };
  }
  const owner = await findOwner(ctx, scope.userId, scope.testMode);
  const remaining = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId_and_testMode_and_generation", (q) =>
      q.eq("userId", scope.userId).eq("testMode", scope.testMode),
    )
    .first();
  if (owner && !remaining) await ctx.db.delete("subscriptionOwners", owner._id);
  return { removed, done: true };
}

export const purge = mutation({
  args: { userId: v.string(), testMode: v.optional(v.boolean()) },
  returns: purgeResultValidator,
  handler: async (ctx, { userId, testMode: requestedTestMode }) => {
    const testMode = resolveTestMode(requestedTestMode, env);
    boundedUtf8String(userId, 256);
    const owner = await findOwner(ctx, userId, testMode);
    const generation = owner ? owner.generation + 1 : 0;
    if (owner) await ctx.db.patch("subscriptionOwners", owner._id, { generation });
    return purgeStep(ctx, { userId, testMode, generation, before: Date.now() });
  },
});

export const continuePurge = internalMutation({
  args: { userId: v.string(), testMode: v.boolean(), generation: v.number(), before: v.number() },
  returns: purgeResultValidator,
  handler: (ctx, scope) => purgeStep(ctx, scope),
});
