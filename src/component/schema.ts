import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  deliveryErrorKindValidator,
  batchStatusValidator,
  countsValidator,
  deliveryStatusValidator,
  notificationStatusValidator,
  sendFieldsValidator,
  pushServiceValidator,
  subscriptionStatusValidator,
  urgencyValidator,
  webPushErrorValidator,
} from "../shared/validators.js";

export default defineSchema({
  subscriptionOwners: defineTable({
    userId: v.string(),
    testMode: v.boolean(),
    generation: v.number(),
  }).index("by_userId_and_testMode", ["userId", "testMode"]),
  subscriptions: defineTable({
    revision: v.number(),
    generation: v.number(),
    userId: v.string(),
    testMode: v.boolean(),
    endpoint: v.string(),

    endpointHash: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    expirationTime: v.optional(v.number()),

    userAgent: v.optional(v.string()),
    pushService: pushServiceValidator,

    vapidPublicKeyHash: v.string(),
    status: subscriptionStatusValidator,
    consecutiveFailures: v.number(),
    lastSuccessAt: v.optional(v.number()),

    lastFailureAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_endpointHash_and_testMode", ["endpointHash", "testMode"])
    .index("by_userId_and_testMode_and_generation", ["userId", "testMode", "generation"])
    .index("by_userId_and_testMode_and_status", ["userId", "testMode", "status"])
    .index("by_status_and_updatedAt", ["status", "updatedAt"]),

  notifications: defineTable({
    userId: v.string(),
    testMode: v.boolean(),
    payload: v.string(),
    payloadEncoding: v.optional(v.literal("base64url")),
    options: v.object({
      ttlSeconds: v.number(),
      urgency: urgencyValidator,
      topic: v.optional(v.string()),
    }),
    idempotencyKey: v.optional(v.string()),
    status: notificationStatusValidator,
    counts: countsValidator,
    allowedPushHosts: v.optional(v.array(v.string())),

    onComplete: v.optional(v.string()),
    endpointHash: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_userId_and_testMode_and_createdAt", ["userId", "testMode", "createdAt"])
    .index("by_userId_and_testMode_and_idempotencyKey", ["userId", "testMode", "idempotencyKey"])
    .index("by_status_and_createdAt", ["status", "createdAt"]),

  batches: defineTable({
    vapidPublicKeyHash: v.string(),
    testMode: v.boolean(),
    userIds: v.array(v.string()),
    nextIndex: v.number(),
    notificationIds: v.array(v.id("notifications")),
    send: sendFieldsValidator,
    onComplete: v.optional(v.string()),
    errorCode: v.optional(webPushErrorValidator.fields.code),
    status: batchStatusValidator,
    createdAt: v.number(),
  }).index("by_status_and_createdAt", ["status", "createdAt"]),

  deliveries: defineTable({
    notificationId: v.id("notifications"),
    subscriptionId: v.id("subscriptions"),
    userId: v.string(),
    testMode: v.boolean(),
    status: deliveryStatusValidator,

    attempts: v.number(),
    subscriptionRevision: v.optional(v.number()),
    providerStatus: v.optional(v.number()),
    errorKind: v.optional(deliveryErrorKindValidator),

    error: v.optional(webPushErrorValidator),
    retryAfterMs: v.optional(v.number()),
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
  })
    .index("by_notificationId", ["notificationId"])
    .index("by_status_and_createdAt", ["status", "createdAt"]),
});
