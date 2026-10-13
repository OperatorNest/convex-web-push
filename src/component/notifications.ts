import {
  paginationOptsValidator,
  paginationResultValidator,
  type FunctionHandle,
} from "convex/server";
import { v, type Infer } from "convex/values";
import { paginator } from "convex-helpers/server/pagination";
import { boundedPage, boundedString, validateHosts } from "../shared/bounds.js";
import { base64urlEncode, base64urlDecode, utf8ByteLength } from "../shared/base64url.js";
import { isTestMode, readMaxParallelism } from "../shared/config.js";
import { MAX_PLAINTEXT_BYTES } from "../shared/encrypt.js";
import { isWebPushError, webPushError, type WebPushErrorCode } from "../shared/errors.js";
import { clampTtl, isValidTopic } from "../shared/push.js";
import {
  vBatchStatus,
  vBatchResult,
  vNotificationResult,
  vSendFields,
  vWebPushError,
} from "../shared/validators.js";
import { vapidKeyFingerprint, readVapidConfig } from "../shared/vapid.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { env, internalMutation, mutation, query, type MutationCtx } from "./_generated/server.js";
import {
  BATCH_SUBSCRIPTION_BUDGET,
  MAX_BATCH_USERS,
  MAX_SUBSCRIPTIONS_PER_USER,
} from "./limits.js";
import { deliveryPool } from "./pool.js";
import schema from "./schema.js";

type SendFields = Infer<typeof vSendFields>;

function validateSend(args: SendFields, resolvedTestMode?: boolean) {
  validateHosts(args.allowedPushHosts);
  if (args.idempotencyKey !== undefined) boundedString(args.idempotencyKey, 256);
  if (args.onComplete !== undefined) boundedString(args.onComplete, 1024);
  if (args.ttl !== undefined && !Number.isFinite(args.ttl))
    throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  if (args.payload.length > 5324) throw webPushError("WEB_PUSH_PAYLOAD_TOO_LARGE");
  const parallelism = readMaxParallelism(env.WEB_PUSH_MAX_PARALLELISM);
  if (!parallelism.ok) throw webPushError("WEB_PUSH_NOT_CONFIGURED");
  if (!(resolvedTestMode ?? isTestMode(args.testMode, env.WEB_PUSH_TEST_MODE))) {
    const config = readVapidConfig(env);
    if (!config.ok) {
      throw webPushError("WEB_PUSH_NOT_CONFIGURED");
    }
  }
  let bytes: number;
  if (args.payloadEncoding === "base64url") {
    try {
      const decoded = base64urlDecode(args.payload);
      bytes = decoded.byteLength;
      args.payload = base64urlEncode(decoded);
    } catch {
      throw webPushError("WEB_PUSH_INVALID_PAYLOAD");
    }
  } else bytes = utf8ByteLength(args.payload);
  if (bytes > MAX_PLAINTEXT_BYTES) {
    throw webPushError("WEB_PUSH_PAYLOAD_TOO_LARGE");
  }
  if (args.topic !== undefined && !isValidTopic(args.topic)) {
    throw webPushError("WEB_PUSH_INVALID_TOPIC");
  }
}

type Enqueued =
  | { deferred: false; notificationId: Id<"notifications"> | null; cost: number }
  | { deferred: true };

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
      .withIndex("by_userId_and_idempotencyKey", (q) =>
        q.eq("userId", userId).eq("idempotencyKey", key),
      )
      .first();
    if (existing) return { deferred: false, notificationId: existing._id, cost: 0 };
  }

  if (budget < MAX_SUBSCRIPTIONS_PER_USER) return { deferred: true };
  const now = Date.now();
  const candidates = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId_and_status", (q) => q.eq("userId", userId).eq("status", "active"))
    .take(MAX_SUBSCRIPTIONS_PER_USER);
  const subscriptions = [];
  for (const subscription of candidates) {
    if (subscription.expirationTime !== undefined && subscription.expirationTime <= now) {
      await ctx.db.patch("subscriptions", subscription._id, { status: "gone", updatedAt: now });
    } else subscriptions.push(subscription);
  }
  if (subscriptions.length === 0)
    return { deferred: false, notificationId: null, cost: candidates.length };

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
  return { deferred: false, notificationId, cost: candidates.length };
}

export const send = mutation({
  args: { userId: v.string(), ...vSendFields.fields },
  returns: v.union(v.id("notifications"), v.null()),
  handler: async (ctx, { userId, ...args }) => {
    boundedString(userId, 256);
    validateSend(args);
    const testMode = isTestMode(args.testMode, env.WEB_PUSH_TEST_MODE);
    const result = await enqueueForUser(ctx, userId, args, testMode, BATCH_SUBSCRIPTION_BUDGET);
    return result.deferred ? null : result.notificationId;
  },
});

const vUserBatchResult = v.object({
  userId: v.string(),
  notificationId: v.union(v.id("notifications"), v.null()),
});

async function finishBatch(
  ctx: MutationCtx,
  batch: Doc<"batches">,
  status: "done" | "failed",
  errorCode?: WebPushErrorCode,
) {
  await ctx.db.patch("batches", batch._id, { status, errorCode });
  if (batch.onComplete)
    await ctx.scheduler.runAfter(0, internal.notifications.invokeCallback, {
      handle: batch.onComplete,
      result: {
        batchId: batch._id,
        status,
        total: batch.userIds.length,
        processed: batch.nextIndex,
        notificationIds: batch.notificationIds,
        ...(errorCode !== undefined && { errorCode }),
      },
    });
}

async function advanceBatch(ctx: MutationCtx, batchId: Id<"batches">) {
  const batch = await ctx.db.get("batches", batchId);
  if (!batch || batch.status !== "running") return [];
  try {
    validateSend(batch.send, batch.send.testMode === true);
    if (batch.vapidPublicKeyHash !== vapidKeyFingerprint(env.VAPID_PUBLIC_KEY))
      throw webPushError("WEB_PUSH_NOT_CONFIGURED");
  } catch (error) {
    if (!isWebPushError(error)) throw error;
    await finishBatch(ctx, batch, "failed", error.data.code);
    return [];
  }
  const results: Infer<typeof vUserBatchResult>[] = [];
  const created = [...batch.notificationIds];
  let index = batch.nextIndex;
  let remaining = BATCH_SUBSCRIPTION_BUDGET;
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
    remaining -= outcome.cost;
    results.push({ userId, notificationId: outcome.notificationId });
    if (outcome.notificationId) created.push(outcome.notificationId);
    index++;
  }
  const done = index >= batch.userIds.length;
  await ctx.db.patch("batches", batchId, {
    nextIndex: index,
    notificationIds: created,
  });
  if (done)
    await finishBatch(ctx, { ...batch, nextIndex: index, notificationIds: created }, "done");
  else await ctx.scheduler.runAfter(0, internal.notifications.continueBatch, { batchId });
  return results;
}

export const sendBatch = mutation({
  args: { userIds: v.array(v.string()), ...vSendFields.fields },
  returns: v.object({
    batchId: v.id("batches"),

    results: v.array(vUserBatchResult),
    done: v.boolean(),
  }),
  handler: async (ctx, { userIds, ...args }) => {
    if (userIds.length > MAX_BATCH_USERS) throw webPushError("WEB_PUSH_BATCH_TOO_LARGE");
    for (const userId of userIds) boundedString(userId, 256);
    const unique = [...new Set(userIds)];
    validateSend(args);
    const batchId = await ctx.db.insert("batches", {
      userIds: unique,
      vapidPublicKeyHash: vapidKeyFingerprint(env.VAPID_PUBLIC_KEY),
      nextIndex: 0,
      notificationIds: [],
      send: {
        payload: args.payload,
        payloadEncoding: args.payloadEncoding,
        ttl: args.ttl,
        urgency: args.urgency,
        topic: args.topic,
        idempotencyKey: args.idempotencyKey,
        allowedPushHosts: args.allowedPushHosts,
        testMode: isTestMode(args.testMode, env.WEB_PUSH_TEST_MODE),
      },
      ...(args.onComplete !== undefined && { onComplete: args.onComplete }),
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
      errorCode: v.optional(vWebPushError.fields.code),
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
      ...(batch.errorCode !== undefined && { errorCode: batch.errorCode }),
      total: batch.userIds.length,
      processed: batch.nextIndex,
      notificationIds: batch.notificationIds,
    };
  },
});

export const get = query({
  args: { notificationId: v.id("notifications"), userId: v.string() },
  returns: v.union(schema.doc("notifications"), v.null()),
  handler: async (ctx, { notificationId, userId }) => {
    boundedString(userId, 256);
    const notification = await ctx.db.get("notifications", notificationId);
    return notification?.userId === userId ? notification : null;
  },
});

export const listForUser = query({
  args: { userId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("notifications")),

  handler: (ctx, { userId, paginationOpts }) => {
    boundedString(userId, 256);
    return paginator(ctx.db, schema)
      .query("notifications")
      .withIndex("by_userId_and_createdAt", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate(boundedPage(paginationOpts));
  },
});

export const invokeCallback = internalMutation({
  args: {
    handle: v.string(),
    result: v.union(vNotificationResult, vBatchResult),
  },
  returns: v.null(),
  handler: async (ctx, { handle, result }) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- handles cross the component boundary as plain strings
    await ctx.runMutation(handle as FunctionHandle<"mutation">, result);
    return null;
  },
});
