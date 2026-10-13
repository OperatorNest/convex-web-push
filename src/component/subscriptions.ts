import { v } from "convex/values";
import { boundedString, truncateText, validateHosts } from "../shared/bounds.js";
import { base64urlEncode, base64urlDecode } from "../shared/base64url.js";
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

function invalid(): never {
  throw webPushError("WEB_PUSH_INVALID_SUBSCRIPTION");
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

// Convex mutations cannot await WebCrypto; this checks the public P-256 curve equation.
const number = (part: Uint8Array) => part.reduce((value, byte) => (value << 8n) + BigInt(byte), 0n);
function validPoint(bytes: Uint8Array): boolean {
  if (bytes[0] !== 4) return false;
  const x = number(bytes.slice(1, 33));
  const y = number(bytes.slice(33));
  const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  const b = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
  return x < p && y < p && (y * y - x * x * x + 3n * x - b) % p === 0n;
}

async function owner(ctx: MutationCtx, userId: string) {
  const found = await ctx.db
    .query("subscriptionOwners")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  if (found) return found;
  const id = await ctx.db.insert("subscriptionOwners", { userId, generation: 0 });
  const created = await ctx.db.get("subscriptionOwners", id);
  if (!created) throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  return created;
}

async function liveSubscriptions(
  ctx: QueryCtx | MutationCtx,
  userId: string,
): Promise<{ active: Doc<"subscriptions">[]; paused: Doc<"subscriptions">[] }> {
  boundedString(userId, 256);
  const active = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId_and_status", (q) => q.eq("userId", userId).eq("status", "active"))
    .take(MAX_SUBSCRIPTIONS_PER_USER);
  const paused = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId_and_status", (q) => q.eq("userId", userId).eq("status", "paused"))
    .take(MAX_SUBSCRIPTIONS_PER_USER);
  return { active, paused };
}

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
    boundedString(args.userId, 256);
    validateHosts(args.allowedPushHosts);
    const { endpoint, keys, expirationTime } = args.subscription;
    if (endpoint.length > 4096 || !endpoint.isWellFormed()) invalid();
    if (expirationTime != null && (!Number.isFinite(expirationTime) || expirationTime < 0))
      invalid();
    const check = checkPushEndpoint(endpoint, args.allowedPushHosts);
    if (!check.ok) invalid();
    const point = keyBytes(keys.p256dh, 65);
    const auth = keyBytes(keys.auth, 16);
    if (!validPoint(point)) invalid();
    const user = await owner(ctx, args.userId);

    const now = Date.now();
    const endpointHash = sha256Hex(endpoint);
    const userAgent = args.userAgent === undefined ? undefined : truncateText(args.userAgent, 256);
    const fields = {
      userId: args.userId,
      p256dh: base64urlEncode(point),
      auth: base64urlEncode(auth),
      generation: user.generation,
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

      await ctx.db.patch("subscriptions", existing._id, {
        ...fields,
        revision: existing.revision + 1,
        expirationTime: expirationTime ?? undefined,
        userAgent,
        status: keepPaused ? "paused" : "active",
      });
      return { subscriptionId: existing._id, created: false };
    }

    await enforceCap(ctx, args.userId, now);
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
  args: { endpoint: v.string(), userId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { endpoint, userId }) => {
    if (endpoint.length === 0 || endpoint.length > 4096 || !endpoint.isWellFormed()) invalid();
    boundedString(userId, 256);
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_endpointHash", (q) => q.eq("endpointHash", sha256Hex(endpoint)))
      .first();
    if (!existing || existing.endpoint !== endpoint) return false;
    if (existing.userId !== userId) return false;
    await ctx.db.delete("subscriptions", existing._id);
    return true;
  },
});

async function purgeUserBatch(ctx: MutationCtx, userId: string, generation: number) {
  const rows = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId_and_generation", (q) =>
      q.eq("userId", userId).lt("generation", generation),
    )
    .take(PURGE_BATCH);
  for (const row of rows) await ctx.db.delete("subscriptions", row._id);
  const done = rows.length < PURGE_BATCH;
  if (!done)
    await ctx.scheduler.runAfter(0, internal.subscriptions.purgeUser, { userId, generation });
  return { removed: rows.length, done };
}

const vPurgeResult = v.object({ removed: v.number(), done: v.boolean() });

export const removeAllForUser = mutation({
  args: { userId: v.string() },
  returns: vPurgeResult,
  handler: async (ctx, { userId }) => {
    boundedString(userId, 256);
    const current = await owner(ctx, userId);
    const generation = current.generation + 1;
    await ctx.db.patch("subscriptionOwners", current._id, { generation });
    return purgeUserBatch(ctx, userId, generation);
  },
});

export const purgeUser = internalMutation({
  args: { userId: v.string(), generation: v.number() },
  returns: vPurgeResult,
  handler: (ctx, { userId, generation }) => purgeUserBatch(ctx, userId, generation),
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
  boundedString(userId, 256);
  const rows = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId_and_status", (q) => q.eq("userId", userId).eq("status", from))
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
