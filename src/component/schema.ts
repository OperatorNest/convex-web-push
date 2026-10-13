import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vBatchStatus,
  vCounts,
  vDeliveryStatus,
  vNotificationStatus,
  vSendFields,
  vService,
  vSubscriptionStatus,
  vUrgency,
  vWebPushError,
} from "../shared/validators.js";

export default defineSchema({
  subscriptionOwners: defineTable({ userId: v.string(), generation: v.number() }).index(
    "by_userId",
    ["userId"],
  ),
  subscriptions: defineTable({
    revision: v.number(),
    generation: v.number(),
    userId: v.string(),
    endpoint: v.string(),

    endpointHash: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    expirationTime: v.optional(v.number()),

    userAgent: v.optional(v.string()),
    service: vService,

    vapidPublicKeyHash: v.string(),
    status: vSubscriptionStatus,
    consecutiveFailures: v.number(),
    lastSuccessAt: v.optional(v.number()),

    lastFailureAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_endpointHash", ["endpointHash"])
    .index("by_userId_and_generation", ["userId", "generation"])
    .index("by_userId_and_status", ["userId", "status"])
    .index("by_status_and_updatedAt", ["status", "updatedAt"]),

  notifications: defineTable({
    userId: v.string(),
    payload: v.string(),
    payloadEncoding: v.optional(v.literal("base64url")),
    options: v.object({ ttl: v.number(), urgency: vUrgency, topic: v.optional(v.string()) }),
    idempotencyKey: v.optional(v.string()),
    status: vNotificationStatus,
    counts: vCounts,
    testMode: v.optional(v.boolean()),
    allowedPushHosts: v.optional(v.array(v.string())),

    onComplete: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_userId_and_createdAt", ["userId", "createdAt"])
    .index("by_userId_and_idempotencyKey", ["userId", "idempotencyKey"])
    .index("by_status_and_createdAt", ["status", "createdAt"]),

  batches: defineTable({
    vapidPublicKeyHash: v.string(),
    userIds: v.array(v.string()),
    nextIndex: v.number(),
    notificationIds: v.array(v.id("notifications")),
    send: vSendFields,
    onComplete: v.optional(v.string()),
    errorCode: v.optional(vWebPushError.fields.code),
    status: vBatchStatus,
    createdAt: v.number(),
  }).index("by_status_and_createdAt", ["status", "createdAt"]),

  deliveries: defineTable({
    notificationId: v.id("notifications"),
    subscriptionId: v.id("subscriptions"),
    userId: v.string(),
    status: vDeliveryStatus,

    testMode: v.optional(v.boolean()),
    attempts: v.number(),
    subscriptionRevision: v.optional(v.number()),
    statusCode: v.optional(v.number()),
    errorKind: v.optional(v.string()),

    error: v.optional(vWebPushError),
    retryAfterMs: v.optional(v.number()),
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
  })
    .index("by_notificationId", ["notificationId"])
    .index("by_status_and_createdAt", ["status", "createdAt"]),
});
