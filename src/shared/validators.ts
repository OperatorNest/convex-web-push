import { v, type Infer } from "convex/values";
import { WEB_PUSH_ERROR_CODES } from "./errors.js";

export const vWebPushError = v.object({
  code: v.union(...WEB_PUSH_ERROR_CODES.map((code) => v.literal(code))),
  message: v.string(),
  providerStatus: v.optional(v.number()),
});

export const vService = v.union(
  v.literal("fcm"),
  v.literal("mozilla"),
  v.literal("apple"),
  v.literal("wns"),
  v.literal("other"),
);

export const vUrgency = v.union(
  v.literal("very-low"),
  v.literal("low"),
  v.literal("normal"),
  v.literal("high"),
);

export const vSubscriptionStatus = v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("gone"),
);

export const vNotificationStatus = v.union(
  v.literal("queued"),
  v.literal("partial"),
  v.literal("delivered"),
  v.literal("failed"),
);

export const vDeliveryStatus = v.union(
  v.literal("queued"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("failed"),
  v.literal("gone"),
  v.literal("retry"),
);

export const vBatchStatus = v.union(v.literal("running"), v.literal("done"), v.literal("failed"));

export const vBatchResult = v.object({
  batchId: v.string(),
  status: v.union(v.literal("done"), v.literal("failed")),
  total: v.number(),
  processed: v.number(),
  notificationIds: v.array(v.string()),
  errorCode: v.optional(vWebPushError.fields.code),
});

export const vCounts = v.object({
  queued: v.number(),
  sent: v.number(),
  failed: v.number(),
  gone: v.number(),
});

export const vWebPushSubscription = v.object({
  endpoint: v.string(),
  expirationTime: v.optional(v.union(v.number(), v.null())),
  keys: v.object({ p256dh: v.string(), auth: v.string() }),
});

export const vNotificationResult = v.object({
  notificationId: v.string(),
  userId: v.string(),
  status: v.union(v.literal("delivered"), v.literal("failed")),
  counts: vCounts,
});

export const vSendFields = v.object({
  payload: v.string(),

  payloadEncoding: v.optional(v.literal("base64url")),
  ttl: v.optional(v.number()),
  urgency: v.optional(vUrgency),
  topic: v.optional(v.string()),
  idempotencyKey: v.optional(v.string()),

  onComplete: v.optional(v.string()),
  testMode: v.optional(v.boolean()),
  allowedPushHosts: v.optional(v.array(v.string())),
});

export const vSendOutcome = v.object({
  kind: v.union(
    v.literal("sent"),
    v.literal("retryable"),
    v.literal("permanent"),
    v.literal("gone"),
  ),
  attempted: v.optional(v.boolean()),
  statusCode: v.optional(v.number()),
  errorKind: v.optional(v.string()),
  retryAfterMs: v.optional(v.number()),
  error: v.optional(vWebPushError),
});

export type Urgency = Infer<typeof vUrgency>;
export type PushService = Infer<typeof vService>;
export type SendOutcome = Infer<typeof vSendOutcome>;
export type SendFields = Infer<typeof vSendFields>;
export type WebPushSubscription = Infer<typeof vWebPushSubscription>;
export type BatchResult = Infer<typeof vBatchResult>;
export type NotificationResult = Infer<typeof vNotificationResult>;
