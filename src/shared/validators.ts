import { v, type Infer } from "convex/values";
import { WEB_PUSH_ERROR_CODES } from "./errors.js";

export const vWebPushError = v.object({
  code: v.union(...WEB_PUSH_ERROR_CODES.map((code) => v.literal(code))),
  message: v.string(),
  retryable: v.optional(v.boolean()),
  providerStatus: v.optional(v.number()),
  providerCode: v.optional(v.string()),
});

export const vPushService = v.union(
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

export const vWebPushBatchCompleteArgs = v.object({
  testMode: v.boolean(),
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

export const vPushSubscription = v.object({
  endpoint: v.string(),
  expirationTime: v.optional(v.union(v.number(), v.null())),
  keys: v.object({ p256dh: v.string(), auth: v.string() }),
});

export const vWebPushNotificationCompleteArgs = v.object({
  testMode: v.boolean(),
  notificationId: v.string(),
  userId: v.string(),
  status: v.union(v.literal("delivered"), v.literal("failed")),
  counts: vCounts,
});

export const vSendFields = v.object({
  payload: v.string(),

  payloadEncoding: v.optional(v.literal("base64url")),
  ttlSeconds: v.number(),
  urgency: vUrgency,
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
  providerStatus: v.optional(v.number()),
  errorKind: v.optional(v.string()),
  retryAfterMs: v.optional(v.number()),
  error: v.optional(vWebPushError),
});

/** Urgency controls the push service’s delivery priority. */
export type Urgency = Infer<typeof vUrgency>;
/** A push service is the provider accepting a subscription’s messages. */
export type PushService = Infer<typeof vPushService>;
/** A send outcome reports provider acceptance, retry eligibility or permanent failure. */
export type SendOutcome = Infer<typeof vSendOutcome>;
/** Send fields contain the encoded payload and delivery arguments. */
export type SendFields = Infer<typeof vSendFields>;
/** A push subscription contains the endpoint, expiration time and encryption keys. */
export type PushSubscription = Infer<typeof vPushSubscription>;
/** A batch result reports enqueueing progress and any terminal failure. */
export type WebPushBatchCompleteArgs = Infer<typeof vWebPushBatchCompleteArgs>;
/** A notification result reports its terminal status and delivery counts. */
export type WebPushNotificationCompleteArgs = Infer<typeof vWebPushNotificationCompleteArgs>;

/** Subscription status records whether sending is active, paused or permanently unavailable. */
export type SubscriptionStatus = Infer<typeof vSubscriptionStatus>;
/** Notification status records whether its deliveries are queued, partial, delivered or failed. */
export type NotificationStatus = Infer<typeof vNotificationStatus>;
/** Delivery status records the queue, attempt, retry or terminal state of a push message. */
export type DeliveryStatus = Infer<typeof vDeliveryStatus>;
/** Batch status records whether notification enqueueing is running, done or failed. */
export type BatchStatus = Infer<typeof vBatchStatus>;
