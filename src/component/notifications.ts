import {
  paginationOptsValidator,
  paginationResultValidator,
  type FunctionHandle,
} from "convex/server";
import { v, type Infer } from "convex/values";
import { paginator } from "convex-helpers/server/pagination";
import { base64urlDecode, utf8ByteLength } from "../shared/base64url.js";
import { isTestMode, readMaxParallelism } from "../shared/config.js";
import { MAX_PLAINTEXT_BYTES } from "../shared/encrypt.js";
import { webPushError } from "../shared/errors.js";
import { clampTtl, isValidTopic } from "../shared/push.js";
import { vBatchStatus, vNotificationResult, vSendFields } from "../shared/validators.js";
import { readVapidConfig } from "../shared/vapid.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { env, internalMutation, mutation, query, type MutationCtx } from "./_generated/server.js";
import { BATCH_DELIVERY_BUDGET, MAX_BATCH_USERS, MAX_SUBSCRIPTIONS_PER_USER } from "./limits.js";
import { deliveryPool } from "./pool.js";
import schema from "./schema.js";

type SendFields = Infer<typeof vSendFields>;

function validateSend(args: SendFields) {
  const parallelism = readMaxParallelism(env.WEB_PUSH_MAX_PARALLELISM);
  if (!parallelism.ok) throw webPushError("WEB_PUSH_NOT_CONFIGURED", parallelism.problem);
  if (!isTestMode(args.testMode, env.WEB_PUSH_TEST_MODE)) {
    const config = readVapidConfig(env);
    if (!config.ok) {
      throw webPushError(
        "WEB_PUSH_NOT_CONFIGURED",
        `${config.problem}. Configure VAPID keys, or opt in to test mode with testMode: true or WEB_PUSH_TEST_MODE=true`,
      );
    }
  }
  let bytes: number;
  if (args.payloadEncoding === "base64url") {
    try {
      bytes = base64urlDecode(args.payload).byteLength;
    } catch {
      throw webPushError("WEB_PUSH_INVALID_PAYLOAD", "payload is not valid base64url");
    }
  } else bytes = utf8ByteLength(args.payload);
  if (bytes > MAX_PLAINTEXT_BYTES) {
    throw webPushError(
      "WEB_PUSH_PAYLOAD_TOO_LARGE",
      `Payload is ${bytes} bytes; the maximum is ${MAX_PLAINTEXT_BYTES}`,
    );
  }
  if (args.topic !== undefined && !isValidTopic(args.topic)) {
    throw webPushError(
      "WEB_PUSH_INVALID_TOPIC",
      "topic must be 1-32 characters of A-Z, a-z, 0-9, _ or -",
    );
  }
}

type Enqueued =
  | { deferred: false; notificationId: Id<"notifications"> | null; deliveries: number }
  | { deferred: true };

/**
 * Enqueues one user's deliveries, or defers the user when they would not fit in `budget`
 * remaining deliveries. A user has at most 50 active subscriptions, so with a full budget (150)
 * the first user of a transaction always fits and a batch always makes progress. Writes run
 * sequentially.
 */
async function enqueueForUser(
  ctx: MutationCtx,
  userId: string,
  args: SendFields,
  testMode: boolean,
  budget: number,
): Promise<Enqueued> {
  if (args.idempotencyKey !== undefined) {
    const key = args.idempotencyKey;
    const existing = await ctx.db
      .query("notifications")
      .withIndex("by_user_idempotencyKey", (q) => q.eq("userId", userId).eq("idempotencyKey", key))
      .first();
    if (existing) return { deferred: false, notificationId: existing._id, deliveries: 0 };
  }

  const now = Date.now();
  const candidates = await ctx.db
    .query("subscriptions")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "active"))
    .take(MAX_SUBSCRIPTIONS_PER_USER);
  const subscriptions = [];
  for (const subscription of candidates) {
    if (subscription.expirationTime !== undefined && subscription.expirationTime <= now) {
      await ctx.db.patch("subscriptions", subscription._id, { status: "gone", updatedAt: now });
    } else subscriptions.push(subscription);
  }
  if (subscriptions.length === 0) return { deferred: false, notificationId: null, deliveries: 0 };
  if (subscriptions.length > budget) return { deferred: true };

  const notificationId = await ctx.db.insert("notifications", {
    userId,
    payload: args.payload,
    options: {
      ttl: clampTtl(args.ttl),
      urgency: args.urgency ?? "normal",
      ...(args.topic !== undefined && { topic: args.topic }),
    },
    status: "queued",
    counts: { queued: subscriptions.length, sent: 0, failed: 0, gone: 0 },
    createdAt: now,
    ...(args.payloadEncoding !== undefined && { payloadEncoding: args.payloadEncoding }),
    ...(args.idempotencyKey !== undefined && { idempotencyKey: args.idempotencyKey }),
    ...(testMode && { testMode: true }),
    ...(args.allowedPushHosts !== undefined && { allowedPushHosts: args.allowedPushHosts }),
    ...(args.onComplete !== undefined && { onComplete: args.onComplete }),
  });

  const pool = deliveryPool();
  for (const subscription of subscriptions) {
    const deliveryId = await ctx.db.insert("deliveries", {
      notificationId,
      subscriptionId: subscription._id,
      userId,
      status: "queued",
      attempts: 0,
      createdAt: now,
      ...(testMode && { testMode: true }),
    });
    await pool.enqueueAction(
      ctx,
      internal.deliver.run,
      { deliveryId },
      { onComplete: internal.deliveries.onComplete, context: { deliveryId } },
    );
  }
  return { deferred: false, notificationId, deliveries: subscriptions.length };
}

export const send = mutation({
  args: { userId: v.string(), ...vSendFields.fields },
  returns: v.union(v.id("notifications"), v.null()),
  handler: async (ctx, { userId, ...args }) => {
    validateSend(args);
    const testMode = isTestMode(args.testMode, env.WEB_PUSH_TEST_MODE);
    const result = await enqueueForUser(ctx, userId, args, testMode, BATCH_DELIVERY_BUDGET);
    return result.deferred ? null : result.notificationId;
  },
});

const vBatchResult = v.object({
  userId: v.string(),
  notificationId: v.union(v.id("notifications"), v.null()),
});

/**
 * Processes users from `nextIndex` until the next user's deliveries would exceed the budget.
 * Test mode was resolved once when the batch was created and applies to every continuation.
 */
async function advanceBatch(ctx: MutationCtx, batchId: Id<"batches">) {
  const batch = await ctx.db.get("batches", batchId);
  if (!batch || batch.status === "done") return [];
  const results: Infer<typeof vBatchResult>[] = [];
  const created = [...batch.notificationIds];
  let index = batch.nextIndex;
  let remaining = BATCH_DELIVERY_BUDGET;
  for (;;) {
    const userId = batch.userIds[index];
    if (userId === undefined) break;
    const outcome = await enqueueForUser(
      ctx,
      userId,
      batch.send,
      batch.send.testMode === true,
      remaining,
    );
    if (outcome.deferred) break;
    remaining -= outcome.deliveries;
    results.push({ userId, notificationId: outcome.notificationId });
    if (outcome.notificationId) created.push(outcome.notificationId);
    index++;
  }
  const done = index >= batch.userIds.length;
  await ctx.db.patch("batches", batchId, {
    nextIndex: index,
    notificationIds: created,
    status: done ? "done" : "running",
  });
  if (!done) await ctx.scheduler.runAfter(0, internal.notifications.continueBatch, { batchId });
  return results;
}

/**
 * One bounded transaction: at most `MAX_BATCH_USERS` users and `BATCH_DELIVERY_BUDGET` deliveries
 * are written here. When the budget runs out, a scheduled `continueBatch` handles the rest.
 */
export const sendBatch = mutation({
  args: { userIds: v.array(v.string()), ...vSendFields.fields },
  returns: v.object({
    batchId: v.id("batches"),
    /** Users handled in this call. The rest continue in scheduled mutations; see `getBatch`. */
    results: v.array(vBatchResult),
    done: v.boolean(),
  }),
  handler: async (ctx, { userIds, ...args }) => {
    const unique = [...new Set(userIds)];
    if (unique.length > MAX_BATCH_USERS) {
      throw webPushError(
        "WEB_PUSH_BATCH_TOO_LARGE",
        `A batch accepts at most ${MAX_BATCH_USERS} users`,
      );
    }
    validateSend(args);
    const batchId = await ctx.db.insert("batches", {
      userIds: unique,
      nextIndex: 0,
      notificationIds: [],
      send: { ...args, testMode: isTestMode(args.testMode, env.WEB_PUSH_TEST_MODE) },
      status: "running",
      createdAt: Date.now(),
    });
    const results = await advanceBatch(ctx, batchId);
    const batch = await ctx.db.get("batches", batchId);
    return { batchId, results, done: batch?.status === "done" };
  },
});

export const continueBatch = internalMutation({
  args: { batchId: v.id("batches") },
  returns: v.null(),
  handler: async (ctx, { batchId }) => {
    await advanceBatch(ctx, batchId);
    return null;
  },
});

export const getBatch = query({
  args: { batchId: v.id("batches") },
  returns: v.union(
    v.object({
      status: vBatchStatus,
      total: v.number(),
      processed: v.number(),
      notificationIds: v.array(v.id("notifications")),
    }),
    v.null(),
  ),
  handler: async (ctx, { batchId }) => {
    const batch = await ctx.db.get("batches", batchId);
    if (!batch) return null;
    return {
      status: batch.status,
      total: batch.userIds.length,
      processed: batch.nextIndex,
      notificationIds: batch.notificationIds,
    };
  },
});

export const get = query({
  args: { notificationId: v.id("notifications") },
  returns: v.union(schema.doc("notifications"), v.null()),
  handler: (ctx, { notificationId }) => ctx.db.get("notifications", notificationId),
});

export const listForUser = query({
  args: { userId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("notifications")),
  // Components cannot call the built-in `.paginate()`, so use convex-helpers' paginator.
  handler: (ctx, { userId, paginationOpts }) =>
    paginator(ctx.db, schema)
      .query("notifications")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate(paginationOpts),
});

/** Runs the app's `onComplete` mutation in its own transaction so a failing callback cannot undo counts. */
export const invokeCallback = internalMutation({
  args: {
    handle: v.string(),
    notificationId: v.id("notifications"),
    userId: v.string(),
    status: vNotificationResult.fields.status,
    counts: vNotificationResult.fields.counts,
  },
  returns: v.null(),
  handler: async (ctx, { handle, ...result }) => {
    // Convex validates the handle when it is invoked; a stale handle fails only this callback.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- handles cross the component boundary as plain strings
    await ctx.runMutation(handle as FunctionHandle<"mutation">, result);
    return null;
  },
});
