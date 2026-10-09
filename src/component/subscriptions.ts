import { v } from "convex/values";
import { base64urlDecode } from "../shared/base64url.js";
import { webPushError } from "../shared/errors.js";
import { checkPushEndpoint } from "../shared/push.js";
import { sha256Hex } from "../shared/sha256.js";
import { vWebPushSubscription } from "../shared/validators.js";
import { vapidKeyFingerprint } from "../shared/vapid.js";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  env,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import { MAX_SUBSCRIPTIONS_PER_USER, PURGE_BATCH } from "./limits.js";

function invalid(message: string): never {
  throw webPushError("WEB_PUSH_INVALID_SUBSCRIPTION", message);
}

function assertKeyLength(label: string, value: string, length: number, firstByte?: number) {
  let bytes: Uint8Array;
  try {
    bytes = base64urlDecode(value);
  } catch {
    invalid(`${label} is not valid base64url`);
  }
  if (bytes.byteLength !== length || (firstByte !== undefined && bytes[0] !== firstByte)) {
    invalid(`${label} has an invalid length or format`);
  }
}

/** A user's active and paused subscriptions, each bounded by the per-user cap. */
async function liveSubscriptions(
  ctx: QueryCtx | MutationCtx,
  userId: string,
): Promise<{ active: Doc<"subscriptions">[]; paused: Doc<"subscriptions">[] }> {
  const active = await ctx.db
    .query("subscriptions")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "active"))
    .take(MAX_SUBSCRIPTIONS_PER_USER);
  const paused = await ctx.db
    .query("subscriptions")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "paused"))
    .take(MAX_SUBSCRIPTIONS_PER_USER);
  return { active, paused };
}

/** Keeps a user's live (active plus paused) subscriptions under the cap by retiring the oldest. */
async function enforceCap(ctx: MutationCtx, userId: string, now: number) {
  const { active, paused } = await liveSubscriptions(ctx, userId);
  const live = [...active, ...paused].toSorted((a, b) => a._creationTime - b._creationTime);
  const excess = live.length - (MAX_SUBSCRIPTIONS_PER_USER - 1);
  for (const row of live.slice(0, Math.max(excess, 0))) {
    await ctx.db.patch("subscriptions", row._id, { status: "gone", updatedAt: now });
  }
}

export const record = mutation({
  args: {
    userId: v.string(),
    subscription: vWebPushSubscription,
    userAgent: v.optional(v.string()),
    allowedPushHosts: v.optional(v.array(v.string())),
  },
  returns: v.object({ subscriptionId: v.id("subscriptions"), created: v.boolean() }),
  handler: async (ctx, args) => {
    const { endpoint, keys, expirationTime } = args.subscription;
    const check = checkPushEndpoint(endpoint, args.allowedPushHosts);
    if (!check.ok) invalid(check.reason);
    assertKeyLength("p256dh", keys.p256dh, 65, 4);
    assertKeyLength("auth", keys.auth, 16);

    const now = Date.now();
    const endpointHash = sha256Hex(endpoint);
    const userAgent = args.userAgent?.slice(0, 256);
    const fields = {
      userId: args.userId,
      p256dh: keys.p256dh,
      auth: keys.auth,
      service: check.service,
      vapidPublicKeyHash: vapidKeyFingerprint(env.VAPID_PUBLIC_KEY),
      consecutiveFailures: 0,
      updatedAt: now,
    };

    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_endpointHash", (q) => q.eq("endpointHash", endpointHash))
      .first();
    if (existing && existing.endpoint === endpoint) {
      const keepPaused = existing.status === "paused" && existing.userId === args.userId;
      const alreadyLive = existing.userId === args.userId && existing.status !== "gone";
      if (!alreadyLive) await enforceCap(ctx, args.userId, now);
      // Patching a field with `undefined` removes it, so a re-subscribe replaces the old values.
      await ctx.db.patch("subscriptions", existing._id, {
        ...fields,
        expirationTime: expirationTime ?? undefined,
        userAgent,
        status: keepPaused ? "paused" : "active",
      });
      return { subscriptionId: existing._id, created: false };
    }

    await enforceCap(ctx, args.userId, now);
    const subscriptionId = await ctx.db.insert("subscriptions", {
      ...fields,
      endpoint,
      endpointHash,
      status: "active",
      createdAt: now,
      ...(expirationTime != null && { expirationTime }),
      ...(userAgent !== undefined && { userAgent }),
    });
    return { subscriptionId, created: true };
  },
});

/**
 * The endpoint is a capability URL, so knowing it is enough to remove the subscription. Pass
 * `userId` to remove it only when it belongs to that user.
 */
export const remove = mutation({
  args: { endpoint: v.string(), userId: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, { endpoint, userId }) => {
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_endpointHash", (q) => q.eq("endpointHash", sha256Hex(endpoint)))
      .first();
    if (!existing || existing.endpoint !== endpoint) return false;
    if (userId !== undefined && existing.userId !== userId) return false;
    await ctx.db.delete("subscriptions", existing._id);
    return true;
  },
});

/** Deletes up to one bounded batch of a user's subscriptions across all statuses. */
async function purgeUserBatch(ctx: MutationCtx, userId: string) {
  let removed = 0;
  for (const status of ["active", "paused", "gone"] as const) {
    if (removed >= PURGE_BATCH) break;
    const rows = await ctx.db
      .query("subscriptions")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
      .take(PURGE_BATCH - removed);
    for (const row of rows) await ctx.db.delete("subscriptions", row._id);
    removed += rows.length;
  }
  const done = removed < PURGE_BATCH;
  if (!done) await ctx.scheduler.runAfter(0, internal.subscriptions.purgeUser, { userId });
  return { removed, done };
}

const vPurgeResult = v.object({ removed: v.number(), done: v.boolean() });

/** Removes the first batch now. When `done` is false the rest is deleted by scheduled batches. */
export const removeAllForUser = mutation({
  args: { userId: v.string() },
  returns: vPurgeResult,
  handler: (ctx, { userId }) => purgeUserBatch(ctx, userId),
});

export const purgeUser = internalMutation({
  args: { userId: v.string() },
  returns: vPurgeResult,
  handler: (ctx, { userId }) => purgeUserBatch(ctx, userId),
});

export const statusForUser = query({
  args: { userId: v.string() },
  returns: v.object({
    subscriptions: v.number(),
    paused: v.number(),
    lastSuccessAt: v.optional(v.number()),
  }),
  handler: async (ctx, { userId }) => {
    const { active, paused } = await liveSubscriptions(ctx, userId);
    let lastSuccessAt: number | undefined;
    for (const row of [...active, ...paused]) {
      if (row.lastSuccessAt !== undefined && row.lastSuccessAt > (lastSuccessAt ?? 0)) {
        lastSuccessAt = row.lastSuccessAt;
      }
    }
    return {
      subscriptions: active.length,
      paused: paused.length,
      ...(lastSuccessAt !== undefined && { lastSuccessAt }),
    };
  },
});

async function moveUserSubscriptions(
  ctx: MutationCtx,
  userId: string,
  from: "active" | "paused",
  to: "active" | "paused",
) {
  const rows = await ctx.db
    .query("subscriptions")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", from))
    .take(MAX_SUBSCRIPTIONS_PER_USER);
  const now = Date.now();
  for (const row of rows) {
    await ctx.db.patch("subscriptions", row._id, { status: to, updatedAt: now });
  }
  return rows.length;
}

export const pauseForUser = mutation({
  args: { userId: v.string() },
  returns: v.number(),
  handler: (ctx, { userId }) => moveUserSubscriptions(ctx, userId, "active", "paused"),
});

export const resumeForUser = mutation({
  args: { userId: v.string() },
  returns: v.number(),
  handler: (ctx, { userId }) => moveUserSubscriptions(ctx, userId, "paused", "active"),
});
