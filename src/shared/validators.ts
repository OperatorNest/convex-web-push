import { v, type Infer } from "convex/values";

/** The only definition of each shape. Types come from `Infer`, never a second hand-written copy. */

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

export const vBatchStatus = v.union(v.literal("running"), v.literal("done"));

export const vCounts = v.object({
  queued: v.number(),
  sent: v.number(),
  failed: v.number(),
  gone: v.number(),
});

/** The JSON from `PushSubscription.toJSON()` in the browser. */
export const vWebPushSubscription = v.object({
  endpoint: v.string(),
  expirationTime: v.optional(v.union(v.number(), v.null())),
  keys: v.object({ p256dh: v.string(), auth: v.string() }),
});

/** Arguments the component passes to your `onComplete` mutation. */
export const vNotificationResult = v.object({
  notificationId: v.string(),
  userId: v.string(),
  status: v.union(v.literal("delivered"), v.literal("failed")),
  counts: vCounts,
});

/** Everything one send carries besides the recipients. */
export const vSendFields = v.object({
  payload: v.string(),
  /** Set to "base64url" when `payload` carries raw bytes instead of UTF-8 text. */
  payloadEncoding: v.optional(v.literal("base64url")),
  ttl: v.optional(v.number()),
  urgency: v.optional(vUrgency),
  topic: v.optional(v.string()),
  idempotencyKey: v.optional(v.string()),
  /** Function handle of the app mutation to call when every delivery has finished. */
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
  statusCode: v.optional(v.number()),
  errorKind: v.optional(v.string()),
  retryAfterMs: v.optional(v.number()),
  detail: v.optional(v.string()),
});

export type Urgency = Infer<typeof vUrgency>;
export type PushService = Infer<typeof vService>;
export type SendOutcome = Infer<typeof vSendOutcome>;
export type SendFields = Infer<typeof vSendFields>;
export type WebPushSubscription = Infer<typeof vWebPushSubscription>;
export type NotificationResult = Infer<typeof vNotificationResult>;
