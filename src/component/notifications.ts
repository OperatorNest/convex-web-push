import {
  paginationOptsValidator,
  paginationResultValidator,
  type FunctionHandle,
} from "convex/server";
import { type ConvexError, v, type Infer } from "convex/values";
import { paginator } from "convex-helpers/server/pagination";
import {
  boundedPage,
  boundedString,
  boundedUtf8String,
  validateHosts,
  validateIdempotencyKey,
} from "../shared/bounds.js";
import { base64urlEncode, base64urlDecode, utf8ByteLength } from "../shared/base64url.js";
import {
  readConfig,
  requireVapidConfig,
  resolveTestMode,
  type WebPushConfig,
} from "../shared/config.js";
import { MAX_ENCODED_PAYLOAD_LENGTH, MAX_PLAINTEXT_BYTES } from "../shared/encrypt.js";
import {
  isWebPushError,
  webPushError,
  type WebPushErrorCode,
  type WebPushErrorData,
} from "../shared/errors.js";
import { validateTtlSeconds, isValidTopic } from "../shared/push.js";
import {
  batchStatusValidator,
  webPushBatchCompleteArgsValidator,
  webPushNotificationCompleteArgsValidator,
  sendFieldsValidator,
  webPushErrorValidator,
} from "../shared/validators.js";
import { vapidKeyFingerprint } from "../shared/vapid.js";
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

type SendFields = Infer<typeof sendFieldsValidator>;

function isMutationHandle(handle: string): handle is FunctionHandle<"mutation"> {
  return handle.startsWith("function://");
}

function validateSend(args: SendFields, testMode: boolean, config: WebPushConfig) {
  validateHosts(args.allowedPushHosts);
  if (args.idempotencyKey !== undefined) validateIdempotencyKey(args.idempotencyKey);
  if (args.onComplete !== undefined) {
    boundedString(args.onComplete, 1024);
    if (!isMutationHandle(args.onComplete)) throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  }
  validateTtlSeconds(args.ttlSeconds);
  if (args.payload.length > MAX_ENCODED_PAYLOAD_LENGTH)
    throw webPushError("WEB_PUSH_PAYLOAD_TOO_LARGE");
  if (!testMode) requireVapidConfig(config);
  let bytes: number;
  if (args.payloadEncoding === "base64url") {
    try {
      const decoded = base64urlDecode(args.payload);
      bytes = decoded.byteLength;
      args.payload = base64urlEncode(decoded);
    } catch {
      throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
    }
  } else bytes = utf8ByteLength(args.payload);
  if (bytes > MAX_PLAINTEXT_BYTES) {
    throw webPushError("WEB_PUSH_PAYLOAD_TOO_LARGE");
  }
  if (args.topic !== undefined && !isValidTopic(args.topic)) {
    throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  }
}

async function findReplay(
  ctx: MutationCtx,
  userId: string,
  args: SendFields,
  testMode: boolean,
): Promise<Id<"notifications"> | undefined> {
  if (args.idempotencyKey === undefined) return undefined;
  const key = args.idempotencyKey;
  const existing = await ctx.db
    .query("notifications")
    .withIndex("by_userId_and_testMode_and_idempotencyKey", (q) =>
      q.eq("userId", userId).eq("testMode", testMode).eq("idempotencyKey", key),
    )
    .first();
  if (!existing) return undefined;
  if (
    existing.payload !== args.payload ||
    existing.payloadEncoding !== args.payloadEncoding ||
    existing.options.ttlSeconds !== args.ttlSeconds ||
    existing.options.urgency !== args.urgency ||
    existing.options.topic !== args.topic ||
    JSON.stringify(existing.allowedPushHosts ?? []) !==
      JSON.stringify(args.allowedPushHosts ?? []) ||
    existing.onComplete !== args.onComplete
  )
    throw webPushError("WEB_PUSH_IDEMPOTENCY_CONFLICT");
  return existing._id;
}

async function enqueueForUser(
  ctx: MutationCtx,
  userId: string,
  args: SendFields,
  testMode: boolean,
): Promise<{ notificationId: Id<"notifications"> | null; cost: number }> {
  const now = Date.now();
  const candidates = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId_and_testMode_and_status", (q) =>
      q.eq("userId", userId).eq("testMode", testMode).eq("status", "active"),
    )
    .take(MAX_SUBSCRIPTIONS_PER_USER);
  const subscriptions = [];
  for (const subscription of candidates) {
    if (subscription.expirationTime !== undefined && subscription.expirationTime <= now) {
      await ctx.db.patch("subscriptions", subscription._id, { status: "gone", updatedAt: now });
    } else subscriptions.push(subscription);
  }
  if (subscriptions.length === 0) return { notificationId: null, cost: candidates.length };

  const notificationId = await ctx.db.insert("notifications", {
    userId,
    payload: args.payload,
    options: {
      ttlSeconds: args.ttlSeconds,
      urgency: args.urgency,
      ...(args.topic !== undefined && { topic: args.topic }),
    },
    status: "queued",
    counts: { queued: subscriptions.length, sent: 0, failed: 0, gone: 0 },
    createdAt: now,
    ...(args.payloadEncoding !== undefined && { payloadEncoding: args.payloadEncoding }),
    ...(args.idempotencyKey !== undefined && { idempotencyKey: args.idempotencyKey }),
    testMode,
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
      testMode,
    });
    await pool.enqueueAction(
      ctx,
      internal.deliver.run,
      { deliveryId },
      { onComplete: internal.deliveries.onComplete, context: { deliveryId } },
    );
  }
  return { notificationId, cost: candidates.length };
}

export const send = mutation({
  args: { userId: v.string(), ...sendFieldsValidator.fields },
  returns: v.union(v.id("notifications"), v.null()),
  handler: async (ctx, { userId, ...args }) => {
    boundedUtf8String(userId, 256);
    const testMode = resolveTestMode(args.testMode, env);
    validateSend(args, testMode, readConfig(env));
    const replay = await findReplay(ctx, userId, args, testMode);
    if (replay !== undefined) return replay;
    return (await enqueueForUser(ctx, userId, args, testMode)).notificationId;
  },
});

const userWebPushBatchCompleteArgsValidator = v.object({
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
        testMode: batch.testMode,
        status,
        total: batch.userIds.length,
        processed: batch.nextIndex,
        notificationIds: batch.notificationIds,
        ...(errorCode !== undefined && { errorCode }),
      },
    });
}

type BatchStep = {
  results: Infer<typeof userWebPushBatchCompleteArgsValidator>[];
  error?: ConvexError<WebPushErrorData>;
};

async function advanceBatch(ctx: MutationCtx, batchId: Id<"batches">): Promise<BatchStep> {
  const batch = await ctx.db.get("batches", batchId);
  if (!batch || batch.status !== "running") return { results: [] };
  const testMode = batch.send.testMode === true;
  const results: BatchStep["results"] = [];
  const created = [...batch.notificationIds];
  let index = batch.nextIndex;
  let remaining = BATCH_SUBSCRIPTION_BUDGET;
  try {
    const config = readConfig(env);
    validateSend(batch.send, testMode, config);
    if (batch.vapidPublicKeyHash !== vapidKeyFingerprint(config.publicKey))
      throw webPushError("WEB_PUSH_NOT_CONFIGURED");
    for (;;) {
      const userId = batch.userIds[index];
      if (userId === undefined) break;
      const replay = await findReplay(ctx, userId, batch.send, testMode);
      let notificationId: Id<"notifications"> | null;
      if (replay === undefined) {
        if (remaining < MAX_SUBSCRIPTIONS_PER_USER) break;
        const outcome = await enqueueForUser(ctx, userId, batch.send, testMode);
        remaining -= outcome.cost;
        notificationId = outcome.notificationId;
      } else notificationId = replay;
      results.push({ userId, notificationId });
      if (notificationId) created.push(notificationId);
      index++;
    }
  } catch (error) {
    if (!isWebPushError(error)) throw error;
    const progress = { nextIndex: index, notificationIds: created };
    await ctx.db.patch("batches", batchId, progress);
    await finishBatch(ctx, { ...batch, ...progress }, "failed", error.data.code);
    return { results, error };
  }
  const progress = { nextIndex: index, notificationIds: created };
  await ctx.db.patch("batches", batchId, progress);
  if (index >= batch.userIds.length) await finishBatch(ctx, { ...batch, ...progress }, "done");
  else await ctx.scheduler.runAfter(0, internal.notifications.continueBatch, { batchId });
  return { results };
}

export const sendBatch = mutation({
  args: { userIds: v.array(v.string()), ...sendFieldsValidator.fields },
  returns: v.object({
    batchId: v.id("batches"),

    results: v.array(userWebPushBatchCompleteArgsValidator),
    done: v.boolean(),
  }),
  handler: async (ctx, { userIds, ...args }) => {
    if (userIds.length > MAX_BATCH_USERS) throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
    for (const userId of userIds) boundedUtf8String(userId, 256);
    const unique = [...new Set(userIds)];
    const config = readConfig(env);
    const testMode = resolveTestMode(args.testMode, env);
    validateSend(args, testMode, config);
    const batchId = await ctx.db.insert("batches", {
      userIds: unique,
      testMode,
      vapidPublicKeyHash: vapidKeyFingerprint(config.publicKey),
      nextIndex: 0,
      notificationIds: [],
      send: {
        payload: args.payload,
        payloadEncoding: args.payloadEncoding,
        ttlSeconds: args.ttlSeconds,
        urgency: args.urgency,
        topic: args.topic,
        idempotencyKey: args.idempotencyKey,
        allowedPushHosts: args.allowedPushHosts,
        testMode,
      },
      ...(args.onComplete !== undefined && { onComplete: args.onComplete }),
      status: "running",
      createdAt: Date.now(),
    });
    const step = await advanceBatch(ctx, batchId);
    if (step.error !== undefined) throw step.error;
    const batch = await ctx.db.get("batches", batchId);
    return { batchId, results: step.results, done: batch?.status === "done" };
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
  args: { batchId: v.id("batches"), testMode: v.optional(v.boolean()) },
  returns: v.object({
    status: batchStatusValidator,
    errorCode: v.optional(webPushErrorValidator.fields.code),
    total: v.number(),
    processed: v.number(),
    notificationIds: v.array(v.id("notifications")),
  }),
  handler: async (ctx, { batchId, testMode }) => {
    const resolvedTestMode = resolveTestMode(testMode, env);
    const batch = await ctx.db.get("batches", batchId);
    if (!batch || batch.testMode !== resolvedTestMode) throw webPushError("WEB_PUSH_NOT_FOUND");
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
  args: {
    notificationId: v.id("notifications"),
    userId: v.string(),
    testMode: v.optional(v.boolean()),
  },
  returns: schema.doc("notifications"),
  handler: async (ctx, { notificationId, userId, testMode }) => {
    boundedUtf8String(userId, 256);
    const notification = await ctx.db.get("notifications", notificationId);
    if (notification?.userId !== userId || notification.testMode !== resolveTestMode(testMode, env))
      throw webPushError("WEB_PUSH_NOT_FOUND");
    return notification;
  },
});

export const list = query({
  args: {
    userId: v.string(),
    testMode: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(schema.doc("notifications")),

  handler: (ctx, { userId, testMode, paginationOpts }) => {
    boundedUtf8String(userId, 256);
    return paginator(ctx.db, schema)
      .query("notifications")
      .withIndex("by_userId_and_testMode_and_createdAt", (q) =>
        q.eq("userId", userId).eq("testMode", resolveTestMode(testMode, env)),
      )
      .order("desc")
      .paginate(boundedPage(paginationOpts, 5));
  },
});

export const invokeCallback = internalMutation({
  args: {
    handle: v.string(),
    result: v.union(webPushNotificationCompleteArgsValidator, webPushBatchCompleteArgsValidator),
  },
  returns: v.null(),
  handler: async (ctx, { handle, result }) => {
    if (!isMutationHandle(handle)) throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
    await ctx.runMutation(handle, result);
    return null;
  },
});
