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
} from "../shared/validators.js";

export default defineSchema({
  subscriptions: defineTable({
    userId: v.string(),
    endpoint: v.string(),
    /** SHA-256 hex of the endpoint: the upsert key, since endpoints can be long. */
    endpointHash: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    expirationTime: v.optional(v.number()),
    /** Operator diagnostics, visible in the Convex dashboard. No API reads these four fields. */
    userAgent: v.optional(v.string()),
    service: vService,
    /** Fingerprint of the VAPID public key at subscribe time, or "none" if it was not configured. */
    vapidPublicKeyHash: v.string(),
    status: vSubscriptionStatus,
    consecutiveFailures: v.number(),
    lastSuccessAt: v.optional(v.number()),
    /** Diagnostics only. */
    lastFailureAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_endpointHash", ["endpointHash"])
    .index("by_user_status", ["userId", "status"])
    .index("by_status_updatedAt", ["status", "updatedAt"]),

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
    /** Function handle of the app mutation to call when every delivery has finished. */
    onComplete: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_user_createdAt", ["userId", "createdAt"])
    .index("by_user_idempotencyKey", ["userId", "idempotencyKey"])
    .index("by_status_createdAt", ["status", "createdAt"]),

  /** Progress of a `sendBatch` call whose fan-out continues across transactions. */
  batches: defineTable({
    userIds: v.array(v.string()),
    nextIndex: v.number(),
    notificationIds: v.array(v.id("notifications")),
    send: vSendFields,
    status: vBatchStatus,
    createdAt: v.number(),
  }).index("by_status_createdAt", ["status", "createdAt"]),

  deliveries: defineTable({
    notificationId: v.id("notifications"),
    subscriptionId: v.id("subscriptions"),
    userId: v.string(),
    status: vDeliveryStatus,
    /** True when created in test mode: recorded, never sent to a push service. */
    testMode: v.optional(v.boolean()),
    attempts: v.number(),
    statusCode: v.optional(v.number()),
    errorKind: v.optional(v.string()),
    /** Truncated push service response body, for debugging only. */
    detail: v.optional(v.string()),
    retryAfterMs: v.optional(v.number()),
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
  })
    .index("by_notification", ["notificationId"])
    .index("by_status_createdAt", ["status", "createdAt"]),
});
