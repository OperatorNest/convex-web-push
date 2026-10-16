import { v } from "convex/values";
import { boundedString, boundedUtf8String, truncateText, validateHosts } from "../shared/bounds.js";
import { base64urlEncode, base64urlDecode } from "../shared/base64url.js";
import { webPushError } from "../shared/errors.js";
import { checkPushEndpoint } from "../shared/push.js";
import { sha256Hex } from "../shared/sha256.js";
import { pushSubscriptionValidator } from "../shared/validators.js";
import { readConfig, requireVapidConfig, resolveTestMode } from "../shared/config.js";
import { isP256PublicKey, vapidKeyFingerprint } from "../shared/vapid.js";
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
import { findByEndpoint, findOwner, purgeResultValidator } from "./owners.js";

function invalid(): never {
  throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
}

function keyBytes(value: string, length: number): Uint8Array<ArrayBuffer> {
  if (value.length > Math.ceil(length / 3) * 4) invalid();
  try {
    const bytes = base64urlDecode(value);
    if (bytes.byteLength !== length) invalid();
    return bytes;
  } catch {
    return invalid();
  }
}

async function registrationUser(ctx: MutationCtx, userId: string, testMode: boolean) {
  const found = await findOwner(ctx, userId, testMode);
  if (found) return found;
  const id = await ctx.db.insert("subscriptionOwners", { userId, testMode, generation: 0 });
  const created = await ctx.db.get("subscriptionOwners", id);
  if (!created) throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  return created;
}

async function liveSubscriptions(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  testMode: boolean,
): Promise<{ active: Doc<"subscriptions">[]; paused: Doc<"subscriptions">[] }> {
  boundedUtf8String(userId, 256);
  const active = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId_and_testMode_and_status", (q) =>
      q.eq("userId", userId).eq("testMode", testMode).eq("status", "active"),
    )
    .take(MAX_SUBSCRIPTIONS_PER_USER);
  const paused = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId_and_testMode_and_status", (q) =>
      q.eq("userId", userId).eq("testMode", testMode).eq("status", "paused"),
    )
    .take(MAX_SUBSCRIPTIONS_PER_USER);
  return { active, paused };
}

async function enforceCap(ctx: MutationCtx, userId: string, testMode: boolean, now: number) {
  const { active, paused } = await liveSubscriptions(ctx, userId, testMode);
  const live = [...active, ...paused].toSorted((a, b) => a._creationTime - b._creationTime);
  const excess = live.length - (MAX_SUBSCRIPTIONS_PER_USER - 1);
  for (const row of live.slice(0, Math.max(excess, 0))) {
    await ctx.db.patch("subscriptions", row._id, { status: "gone", updatedAt: now });
  }
}

export const record = mutation({
  args: {
    userId: v.string(),
    testMode: v.optional(v.boolean()),
    subscription: pushSubscriptionValidator,
    userAgent: v.optional(v.string()),
    allowedPushHosts: v.optional(v.array(v.string())),
  },
  returns: v.object({ subscriptionId: v.id("subscriptions"), created: v.boolean() }),
  handler: async (ctx, args) => {
    const config = readConfig(env);
    const testMode = resolveTestMode(args.testMode, env);
    if (!testMode) requireVapidConfig(config);
    boundedUtf8String(args.userId, 256);
    validateHosts(args.allowedPushHosts);
    const { endpoint, keys, expirationTime } = args.subscription;
    boundedString(endpoint, 4096);
    if (expirationTime != null && (!Number.isFinite(expirationTime) || expirationTime < 0))
      invalid();
    const check = checkPushEndpoint(endpoint, args.allowedPushHosts);
    if (!check.ok) invalid();
    const point = keyBytes(keys.p256dh, 65);
    const auth = keyBytes(keys.auth, 16);
    if (!isP256PublicKey(point)) invalid();
    const user = await registrationUser(ctx, args.userId, testMode);

    const now = Date.now();
    const endpointHash = sha256Hex(endpoint);
    const userAgent = args.userAgent === undefined ? undefined : truncateText(args.userAgent, 256);
    const fields = {
      userId: args.userId,
      testMode,
      p256dh: base64urlEncode(point),
      auth: base64urlEncode(auth),
      generation: user.generation,
      pushService: check.pushService,
      vapidPublicKeyHash: vapidKeyFingerprint(config.publicKey),
      consecutiveFailures: 0,
      updatedAt: now,
    };

    const existing = await findByEndpoint(ctx, endpoint, testMode);
    if (existing) {
      const keepPaused = existing.status === "paused" && existing.userId === args.userId;
      const alreadyLive = existing.userId === args.userId && existing.status !== "gone";
      if (!alreadyLive) await enforceCap(ctx, args.userId, testMode, now);

      await ctx.db.patch("subscriptions", existing._id, {
        ...fields,
        revision: existing.revision + 1,
        expirationTime: expirationTime ?? undefined,
        userAgent,
        status: keepPaused ? "paused" : "active",
      });
      return { subscriptionId: existing._id, created: false };
    }

    await enforceCap(ctx, args.userId, testMode, now);
    const subscriptionId = await ctx.db.insert("subscriptions", {
      ...fields,
      revision: 0,
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

export const remove = mutation({
  args: { endpoint: v.string(), userId: v.string(), testMode: v.optional(v.boolean()) },
  returns: v.boolean(),
  handler: async (ctx, { endpoint, userId, testMode: requestedTestMode }) => {
    const testMode = resolveTestMode(requestedTestMode, env);
    boundedString(endpoint, 4096);
    boundedUtf8String(userId, 256);
    const existing = await findByEndpoint(ctx, endpoint, testMode);
    if (!existing || existing.userId !== userId) return false;
    await ctx.db.delete("subscriptions", existing._id);
    return true;
  },
});

async function purgeUserBatch(
  ctx: MutationCtx,
  userId: string,
  testMode: boolean,
  generation: number,
) {
  const rows = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId_and_testMode_and_generation", (q) =>
      q.eq("userId", userId).eq("testMode", testMode).lt("generation", generation),
    )
    .take(PURGE_BATCH);
  for (const row of rows) await ctx.db.delete("subscriptions", row._id);
  const done = rows.length < PURGE_BATCH;
  if (!done)
    await ctx.scheduler.runAfter(0, internal.subscriptions.purgeUser, {
      userId,
      testMode,
      generation,
    });
  return { removed: rows.length, done };
}

export const removeAll = mutation({
  args: { userId: v.string(), testMode: v.optional(v.boolean()) },
  returns: purgeResultValidator,
  handler: async (ctx, { userId, testMode: requestedTestMode }) => {
    const testMode = resolveTestMode(requestedTestMode, env);
    boundedUtf8String(userId, 256);
    const current = await registrationUser(ctx, userId, testMode);
    const generation = current.generation + 1;
    await ctx.db.patch("subscriptionOwners", current._id, { generation });
    return purgeUserBatch(ctx, userId, testMode, generation);
  },
});

export const purgeUser = internalMutation({
  args: { userId: v.string(), testMode: v.boolean(), generation: v.number() },
  returns: purgeResultValidator,
  handler: (ctx, { userId, testMode, generation }) =>
    purgeUserBatch(ctx, userId, testMode, generation),
});

export const getStatus = query({
  args: { userId: v.string(), testMode: v.optional(v.boolean()) },
  returns: v.object({
    activeCount: v.number(),
    pausedCount: v.number(),
    lastSuccessAt: v.optional(v.number()),
  }),
  handler: async (ctx, { userId, testMode: requestedTestMode }) => {
    const testMode = resolveTestMode(requestedTestMode, env);
    const { active, paused } = await liveSubscriptions(ctx, userId, testMode);
    let lastSuccessAt: number | undefined;
    for (const row of [...active, ...paused]) {
      if (row.lastSuccessAt !== undefined && row.lastSuccessAt > (lastSuccessAt ?? 0)) {
        lastSuccessAt = row.lastSuccessAt;
      }
    }
    return {
      activeCount: active.length,
      pausedCount: paused.length,
      ...(lastSuccessAt !== undefined && { lastSuccessAt }),
    };
  },
});

async function moveUserSubscriptions(
  ctx: MutationCtx,
  userId: string,
  testMode: boolean,
  from: "active" | "paused",
  to: "active" | "paused",
) {
  boundedUtf8String(userId, 256);
  const rows = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId_and_testMode_and_status", (q) =>
      q.eq("userId", userId).eq("testMode", testMode).eq("status", from),
    )
    .take(MAX_SUBSCRIPTIONS_PER_USER);
  const now = Date.now();
  for (const row of rows) {
    await ctx.db.patch("subscriptions", row._id, { status: to, updatedAt: now });
  }
  return rows.length;
}

export const pause = mutation({
  args: { userId: v.string(), testMode: v.optional(v.boolean()) },
  returns: v.number(),
  handler: (ctx, { userId, testMode }) =>
    moveUserSubscriptions(ctx, userId, resolveTestMode(testMode, env), "active", "paused"),
});

export const resume = mutation({
  args: { userId: v.string(), testMode: v.optional(v.boolean()) },
  returns: v.number(),
  handler: (ctx, { userId, testMode }) =>
    moveUserSubscriptions(ctx, userId, resolveTestMode(testMode, env), "paused", "active"),
});
