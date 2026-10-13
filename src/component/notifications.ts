import {
  paginationOptsValidator,
  paginationResultValidator,
  type FunctionHandle,
} from "convex/server";
import { v, type Infer } from "convex/values";
import { paginator } from "convex-helpers/server/pagination";
import { boundedPage, boundedString, validateHosts } from "../shared/bounds.js";
import { base64urlEncode, base64urlDecode, utf8ByteLength } from "../shared/base64url.js";
import { isTestMode, readConfig, requireVapidConfig } from "../shared/config.js";
import { MAX_PLAINTEXT_BYTES } from "../shared/encrypt.js";
import { isWebPushError, webPushError, type WebPushErrorCode } from "../shared/errors.js";
import { validateTtlSeconds, isValidTopic } from "../shared/push.js";
import {
  vBatchStatus,
  vWebPushBatchCompleteArgs,
  vWebPushNotificationCompleteArgs,
  vSendFields,
  vWebPushError,
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

type SendFields = Infer<typeof vSendFields>;

function validateSend(args: SendFields, resolvedTestMode?: boolean) {
  validateHosts(args.allowedPushHosts);
  if (args.idempotencyKey !== undefined) boundedString(args.idempotencyKey, 256);
  if (args.onComplete !== undefined) boundedString(args.onComplete, 1024);
  if (args.ttlSeconds !== undefined && !Number.isFinite(args.ttlSeconds))
    throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  if (args.payload.length > 5324) throw webPushError("WEB_PUSH_PAYLOAD_TOO_LARGE");
  const config = readConfig(env);
  if (!(resolvedTestMode ?? isTestMode(args.testMode, config.testMode))) requireVapidConfig(config);
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
      .withIndex("by_userId_and_testMode_and_idempotencyKey", (q) =>
        q.eq("userId", userId).eq("testMode", testMode).eq("idempotencyKey", key),
      )
      .first();
    if (existing) {
      const requestedOptions = {
        ttlSeconds: validateTtlSeconds(args.ttlSeconds),
        urgency: args.urgency,
        topic: args.topic,
      };
      if (
        existing.payload !== args.payload ||
        existing.payloadEncoding !== args.payloadEncoding ||
        existing.options.ttlSeconds !== requestedOptions.ttlSeconds ||
        existing.options.urgency !== requestedOptions.urgency ||
        existing.options.topic !== requestedOptions.topic ||
        JSON.stringify(existing.allowedPushHosts ?? []) !==
          JSON.stringify(args.allowedPushHosts ?? []) ||
        existing.onComplete !== args.onComplete
      )
        throw webPushError("WEB_PUSH_IDEMPOTENCY_CONFLICT");
      return { deferred: false, notificationId: existing._id, cost: 0 };
    }
  }

  if (budget < MAX_SUBSCRIPTIONS_PER_USER) return { deferred: true };
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
  if (subscriptions.length === 0)
    return { deferred: false, notificationId: null, cost: candidates.length };

  const notificationId = await ctx.db.insert("notifications", {
    userId,
    payload: args.payload,
    options: {
      ttlSeconds: validateTtlSeconds(args.ttlSeconds),
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
  return { deferred: false, notificationId, cost: candidates.length };
}

export const send = mutation({
  args: { userId: v.string(), ...vSendFields.fields },
  returns: v.union(v.id("notifications"), v.null()),
  handler: async (ctx, { userId, ...args }) => {
    boundedString(userId, 256);
    validateSend(args);
    const testMode = isTestMode(args.testMode, readConfig(env).testMode);
    const result = await enqueueForUser(ctx, userId, args, testMode, BATCH_SUBSCRIPTION_BUDGET);
    return result.deferred ? null : result.notificationId;
  },
});

const vUserWebPushBatchCompleteArgs = v.object({
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

async function advanceBatch(ctx: MutationCtx, batchId: Id<"batches">) {
  const batch = await ctx.db.get("batches", batchId);
  if (!batch || batch.status !== "running") return [];
  try {
    validateSend(batch.send, batch.send.testMode === true);
    if (batch.vapidPublicKeyHash !== vapidKeyFingerprint(readConfig(env).publicKey))
      throw webPushError("WEB_PUSH_NOT_CONFIGURED");
  } catch (error) {
    if (!isWebPushError(error)) throw error;
    await finishBatch(ctx, batch, "failed", error.data.code);
    return [];
  }
  const results: Infer<typeof vUserWebPushBatchCompleteArgs>[] = [];
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

    results: v.array(vUserWebPushBatchCompleteArgs),
    done: v.boolean(),
  }),
  handler: async (ctx, { userIds, ...args }) => {
    if (userIds.length > MAX_BATCH_USERS) throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
    for (const userId of userIds) boundedString(userId, 256);
    const unique = [...new Set(userIds)];
    validateSend(args);
    const batchId = await ctx.db.insert("batches", {
      userIds: unique,
      testMode: isTestMode(args.testMode, readConfig(env).testMode),
      vapidPublicKeyHash: vapidKeyFingerprint(readConfig(env).publicKey),
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
        testMode: isTestMode(args.testMode, readConfig(env).testMode),
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
  args: { batchId: v.id("batches"), testMode: v.optional(v.boolean()) },
  returns: v.object({
    status: vBatchStatus,
    errorCode: v.optional(vWebPushError.fields.code),
    total: v.number(),
    processed: v.number(),
    notificationIds: v.array(v.id("notifications")),
  }),
  handler: async (ctx, { batchId, testMode }) => {
    const resolvedTestMode = isTestMode(testMode, readConfig(env).testMode);
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
    boundedString(userId, 256);
    const notification = await ctx.db.get("notifications", notificationId);
    if (
      notification?.userId !== userId ||
      notification.testMode !== isTestMode(testMode, readConfig(env).testMode)
    )
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
    boundedString(userId, 256);
    return paginator(ctx.db, schema)
      .query("notifications")
      .withIndex("by_userId_and_testMode_and_createdAt", (q) =>
        q.eq("userId", userId).eq("testMode", isTestMode(testMode, readConfig(env).testMode)),
      )
      .order("desc")
      .paginate(boundedPage(paginationOpts));
  },
});

export const invokeCallback = internalMutation({
  args: {
    handle: v.string(),
    result: v.union(vWebPushNotificationCompleteArgs, vWebPushBatchCompleteArgs),
  },
  returns: v.null(),
  handler: async (ctx, { handle, result }) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- handles cross the component boundary as plain strings
    await ctx.runMutation(handle as FunctionHandle<"mutation">, result);
    return null;
  },
});
