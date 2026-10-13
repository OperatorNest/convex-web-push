import { v, type Infer } from "convex/values";
import { WEB_PUSH_ERROR_CODES } from "./errors.js";

export const webPushErrorValidator = v.object({
  code: v.union(...WEB_PUSH_ERROR_CODES.map((code) => v.literal(code))),
  message: v.string(),
  retryable: v.optional(v.boolean()),
  providerStatus: v.optional(v.number()),
  providerCode: v.optional(v.string()),
});

export const pushServiceValidator = v.union(
  v.literal("fcm"),
  v.literal("mozilla"),
  v.literal("apple"),
  v.literal("wns"),
  v.literal("other"),
);

export const urgencyValidator = v.union(
  v.literal("very-low"),
  v.literal("low"),
  v.literal("normal"),
  v.literal("high"),
);

export const subscriptionStatusValidator = v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("gone"),
);

export const notificationStatusValidator = v.union(
  v.literal("queued"),
  v.literal("partial"),
  v.literal("delivered"),
  v.literal("failed"),
);

export const deliveryStatusValidator = v.union(
  v.literal("queued"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("failed"),
  v.literal("gone"),
  v.literal("retry"),
);

export const batchStatusValidator = v.union(
  v.literal("running"),
  v.literal("done"),
  v.literal("failed"),
);

export const webPushBatchCompleteArgsValidator = v.object({
  testMode: v.boolean(),
  batchId: v.string(),
  status: v.union(v.literal("done"), v.literal("failed")),
  total: v.number(),
  processed: v.number(),
  notificationIds: v.array(v.string()),
  errorCode: v.optional(webPushErrorValidator.fields.code),
});

export const countsValidator = v.object({
  queued: v.number(),
  sent: v.number(),
  failed: v.number(),
  gone: v.number(),
});

export const pushSubscriptionValidator = v.object({
  endpoint: v.string(),
  expirationTime: v.optional(v.union(v.number(), v.null())),
  keys: v.object({ p256dh: v.string(), auth: v.string() }),
});

export const webPushNotificationCompleteArgsValidator = v.object({
  testMode: v.boolean(),
  notificationId: v.string(),
  userId: v.string(),
  status: v.union(v.literal("delivered"), v.literal("failed")),
  counts: countsValidator,
});

export const sendFieldsValidator = v.object({
  payload: v.string(),

  payloadEncoding: v.optional(v.literal("base64url")),
  ttlSeconds: v.number(),
  urgency: urgencyValidator,
  topic: v.optional(v.string()),
  idempotencyKey: v.optional(v.string()),

  onComplete: v.optional(v.string()),
  testMode: v.optional(v.boolean()),
  allowedPushHosts: v.optional(v.array(v.string())),
});

export const DELIVERY_ERROR_KINDS = [
  "delivery_closed",
  "notification_missing",
  "subscription_removed",
  "reassigned",
  "subscription_gone",
  "subscription_expired",
  "subscription_paused",
  "ttl_expired",
  "vapid_not_configured",
  "vapid_key_mismatch",
  "invalid_vapid_key",
  "endpoint_not_allowed",
  "payload_too_large",
  "invalid_subscription_keys",
  "crypto_unsupported",
  "timeout",
  "network_error",
  "rate_limited",
  "server_error",
  "vapid_rejected",
  "unexpected_redirect",
  "bad_request",
  "invalid_result",
  "action_failed",
  "canceled",
  "max_attempts",
] as const;

export const deliveryErrorKindValidator = v.union(
  ...DELIVERY_ERROR_KINDS.map((kind) => v.literal(kind)),
);

export const sendOutcomeValidator = v.object({
  kind: v.union(
    v.literal("sent"),
    v.literal("retryable"),
    v.literal("permanent"),
    v.literal("gone"),
  ),
  attempted: v.optional(v.boolean()),
  providerStatus: v.optional(v.number()),
  errorKind: v.optional(deliveryErrorKindValidator),
  retryAfterMs: v.optional(v.number()),
  error: v.optional(webPushErrorValidator),
});

/** Urgency controls the push service’s delivery priority. */
export type Urgency = Infer<typeof urgencyValidator>;
/** A push service is the provider accepting a subscription’s messages. */
export type PushService = Infer<typeof pushServiceValidator>;
/** A send outcome reports provider acceptance, retry eligibility or permanent failure. */
export type SendOutcome = Infer<typeof sendOutcomeValidator>;
/** Send fields contain the encoded payload and delivery arguments. */
export type SendFields = Infer<typeof sendFieldsValidator>;
/** A serialized push subscription contains the endpoint, expiration time and encryption keys. */
export type PushSubscriptionJSON = Infer<typeof pushSubscriptionValidator>;
/** A delivery error kind names why a delivery attempt did not reach the sent status. */
export type DeliveryErrorKind = Infer<typeof deliveryErrorKindValidator>;
/** A batch result reports enqueueing progress and any terminal failure. */
export type WebPushBatchCompleteArgs = Infer<typeof webPushBatchCompleteArgsValidator>;
/** A notification result reports its terminal status and delivery counts. */
export type WebPushNotificationCompleteArgs = Infer<
  typeof webPushNotificationCompleteArgsValidator
>;

/** Subscription status records whether sending is active, paused or permanently unavailable. */
export type SubscriptionStatus = Infer<typeof subscriptionStatusValidator>;
/** Notification status records whether its deliveries are queued, partial, delivered or failed. */
export type NotificationStatus = Infer<typeof notificationStatusValidator>;
/** Delivery status records the queue, attempt, retry or terminal state of a push message. */
export type DeliveryStatus = Infer<typeof deliveryStatusValidator>;
/** Batch status records whether notification enqueueing is running, done or failed. */
export type BatchStatus = Infer<typeof batchStatusValidator>;
