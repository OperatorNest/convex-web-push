import {
  createFunctionHandle,
  type FunctionReference_future,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type PaginationOptions,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import { base64urlEncode, utf8ByteLength } from "../shared/base64url.js";
import {
  assertPayloadSize,
  serializeNotification,
  type PushNotification,
} from "../shared/notification.js";
import type {
  WebPushBatchCompleteArgs,
  WebPushNotificationCompleteArgs,
  SendFields,
  Urgency,
  PushSubscription,
} from "../shared/validators.js";

export { generateVapidKeys, type VapidKeys } from "../shared/vapid.js";
export { MAX_PLAINTEXT_BYTES } from "../shared/encrypt.js";
export {
  WEB_PUSH_ERROR_CODES,
  isWebPushError,
  type WebPushErrorCode,
  type WebPushErrorData,
} from "../shared/errors.js";
export {
  vWebPushBatchCompleteArgs,
  vWebPushNotificationCompleteArgs,
  vPushSubscription,
} from "../shared/validators.js";
export type { PushNotification } from "../shared/notification.js";
export type {
  WebPushBatchCompleteArgs,
  WebPushNotificationCompleteArgs,
  Urgency,
  PushSubscription,
  PushService,
  SubscriptionStatus,
  NotificationStatus,
  DeliveryStatus,
  BatchStatus,
} from "../shared/validators.js";

/** The query context can read stored component rows. */
export type QueryContext = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
/** The mutation context can update component rows atomically. */
export type MutationContext = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
/** The action context can execute component verification. */
export type ActionContext = Pick<GenericActionCtx<GenericDataModel>, "runAction">;

/** A notification ID identifies a stored component notification. */
export type NotificationId = string;

/** Web Push options select test mode, allowed push hosts and internal completion callbacks. */
export type WebPushOptions = {
  testMode?: boolean | undefined;

  allowedPushHosts?: string[] | undefined;
  onNotificationComplete?: FunctionReference_future<
    "mutation",
    "internal",
    WebPushNotificationCompleteArgs,
    null
  >;
  onBatchComplete?: FunctionReference_future<
    "mutation",
    "internal",
    WebPushBatchCompleteArgs,
    null
  >;
};

/** Send options set the message lifetime, urgency, replacement topic and idempotency key. */
export type SendOptions = {
  ttlSeconds: number;
  urgency: Urgency;

  topic?: string | undefined;

  idempotencyKey?: string | undefined;
};

/** WebPush records subscriptions and enqueues notifications with durable delivery attempts. */
export class WebPush {
  constructor(
    private readonly component: ComponentApi,
    private readonly options: WebPushOptions = {},
  ) {}

  readonly subscriptions = {
    /** Record or refresh a push subscription for a user. */
    record: (
      ctx: MutationContext,
      args: { userId: string; subscription: PushSubscription; userAgent?: string | undefined },
    ) => {
      return ctx.runMutation(
        this.component.subscriptions.record,
        definedFields({
          testMode: this.options.testMode,
          userId: args.userId,
          subscription: {
            endpoint: args.subscription.endpoint,
            expirationTime: args.subscription.expirationTime,
            keys: { p256dh: args.subscription.keys.p256dh, auth: args.subscription.keys.auth },
          },
          userAgent: args.userAgent,
          allowedPushHosts: this.options.allowedPushHosts,
        }),
      );
    },

    /** Remove a push subscription belonging to the user. */
    remove: (ctx: MutationContext, args: { endpoint: string; userId: string }) => {
      return ctx.runMutation(
        this.component.subscriptions.remove,
        definedFields({
          testMode: this.options.testMode,
          endpoint: args.endpoint,
          userId: args.userId,
        }),
      );
    },

    /** Remove the user’s subscriptions while preserving later registrations. */
    removeAll: (ctx: MutationContext, args: { userId: string }) => {
      return ctx.runMutation(
        this.component.subscriptions.removeAll,
        definedFields({ testMode: this.options.testMode, userId: args.userId }),
      );
    },

    /** Read the user’s active and paused subscription counts. */
    getStatus: (ctx: QueryContext, args: { userId: string }) => {
      return ctx.runQuery(
        this.component.subscriptions.getStatus,
        definedFields({ testMode: this.options.testMode, userId: args.userId }),
      );
    },

    /** Pause the user’s active subscriptions. */
    pause: (ctx: MutationContext, args: { userId: string }) => {
      return ctx.runMutation(
        this.component.subscriptions.pause,
        definedFields({ testMode: this.options.testMode, userId: args.userId }),
      );
    },

    /** Resume the user’s paused subscriptions. */
    resume: (ctx: MutationContext, args: { userId: string }) => {
      return ctx.runMutation(
        this.component.subscriptions.resume,
        definedFields({ testMode: this.options.testMode, userId: args.userId }),
      );
    },

    /** Read the configured application server public key for subscribing. */
    readApplicationServerKey: (ctx: QueryContext, _args: Record<string, never>) => {
      return ctx.runQuery(
        this.component.subscriptions.readApplicationServerKey,
        definedFields({ testMode: this.options.testMode }),
      );
    },
  };

  readonly notifications = {
    /** Enqueue a displayed notification for the user’s active subscriptions. */
    send: async (
      ctx: MutationContext,
      args: { userId: string; notification: PushNotification } & SendOptions,
    ) => {
      const fields = await buildSendFields(
        this.options,
        serializeNotification(args.notification),
        args,
        this.options.onNotificationComplete,
      );
      return ctx.runMutation(
        this.component.notifications.send,
        definedFields({
          userId: args.userId,
          payload: fields.payload,
          payloadEncoding: fields.payloadEncoding,
          ttlSeconds: fields.ttlSeconds,
          urgency: fields.urgency,
          topic: fields.topic,
          idempotencyKey: fields.idempotencyKey,
          onComplete: fields.onComplete,
          testMode: fields.testMode,
          allowedPushHosts: fields.allowedPushHosts,
        }),
      );
    },

    /** Enqueue a notification for each supplied user in bounded batches. */
    sendBatch: async (
      ctx: MutationContext,
      args: {
        userIds: string[];
        notification: PushNotification;
      } & SendOptions,
    ) => {
      const fields = await buildSendFields(
        this.options,
        serializeNotification(args.notification),
        args,
        this.options.onBatchComplete,
      );
      return ctx.runMutation(
        this.component.notifications.sendBatch,
        definedFields({
          userIds: args.userIds,
          payload: fields.payload,
          payloadEncoding: fields.payloadEncoding,
          ttlSeconds: fields.ttlSeconds,
          urgency: fields.urgency,
          topic: fields.topic,
          idempotencyKey: fields.idempotencyKey,
          onComplete: fields.onComplete,
          testMode: fields.testMode,
          allowedPushHosts: fields.allowedPushHosts,
        }),
      );
    },

    /** Enqueue a raw push message for a custom service worker. */
    sendRaw: async (
      ctx: MutationContext,
      args: { userId: string; payload: string | Uint8Array } & SendOptions,
    ) => {
      assertPayloadSize(
        typeof args.payload === "string" ? utf8ByteLength(args.payload) : args.payload.byteLength,
      );
      const [payload, encoding] =
        typeof args.payload === "string"
          ? ([args.payload, undefined] as const)
          : ([base64urlEncode(args.payload), "base64url"] as const);
      const fields = await buildSendFields(
        this.options,
        payload,
        args,
        this.options.onNotificationComplete,
        encoding,
      );
      return ctx.runMutation(
        this.component.notifications.send,
        definedFields({
          userId: args.userId,
          payload: fields.payload,
          payloadEncoding: fields.payloadEncoding,
          ttlSeconds: fields.ttlSeconds,
          urgency: fields.urgency,
          topic: fields.topic,
          idempotencyKey: fields.idempotencyKey,
          onComplete: fields.onComplete,
          testMode: fields.testMode,
          allowedPushHosts: fields.allowedPushHosts,
        }),
      );
    },

    /** Read a stored notification belonging to the user. */
    get: (ctx: QueryContext, args: { notificationId: NotificationId; userId: string }) => {
      return ctx.runQuery(
        this.component.notifications.get,
        definedFields({
          testMode: this.options.testMode,
          notificationId: args.notificationId,
          userId: args.userId,
        }),
      );
    },

    /** Read the stored progress of a notification batch. */
    getBatch: (ctx: QueryContext, args: { batchId: string }) => {
      return ctx.runQuery(
        this.component.notifications.getBatch,
        definedFields({ testMode: this.options.testMode, batchId: args.batchId }),
      );
    },

    /** List the user’s stored notifications newest first. */
    list: (ctx: QueryContext, args: { userId: string; paginationOpts: PaginationOptions }) => {
      return ctx.runQuery(
        this.component.notifications.list,
        definedFields({
          testMode: this.options.testMode,
          userId: args.userId,
          paginationOpts: {
            numItems: args.paginationOpts.numItems,
            cursor: args.paginationOpts.cursor,
            endCursor: args.paginationOpts.endCursor,

            maximumRowsRead: args.paginationOpts.maximumRowsRead,
            maximumBytesRead: args.paginationOpts.maximumBytesRead,
          },
        }),
      );
    },
  };

  readonly deliveries = {
    /** List stored delivery attempts for the user’s notification. */
    list: (ctx: QueryContext, args: { notificationId: NotificationId; userId: string }) => {
      return ctx.runQuery(
        this.component.deliveries.list,
        definedFields({
          testMode: this.options.testMode,
          notificationId: args.notificationId,
          userId: args.userId,
        }),
      );
    },

    /** Verify WebCrypto operations and the configured VAPID key pair without sending. */
    verify: (ctx: ActionContext, _args: Record<string, never>) => {
      return ctx.runAction(
        this.component.deliveries.verify,
        definedFields({ testMode: this.options.testMode }),
      );
    },
  };
}

async function buildSendFields<
  Result extends WebPushNotificationCompleteArgs | WebPushBatchCompleteArgs,
>(
  clientOptions: WebPushOptions,
  payload: string,
  options: SendOptions,
  onComplete: FunctionReference_future<"mutation", "internal", Result, null> | undefined,
  payloadEncoding?: "base64url",
): Promise<SendFields> {
  return {
    payload,
    ...(payloadEncoding !== undefined && { payloadEncoding }),
    ttlSeconds: options.ttlSeconds,
    urgency: options.urgency,
    ...(options?.topic !== undefined && { topic: options.topic }),
    ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
    ...(onComplete !== undefined && {
      onComplete: await createFunctionHandle(onComplete),
    }),
    ...(clientOptions.testMode !== undefined && { testMode: clientOptions.testMode }),
    ...(clientOptions.allowedPushHosts !== undefined && {
      allowedPushHosts: clientOptions.allowedPushHosts,
    }),
  };
}

function definedFields<T extends object>(fields: T): T {
  for (const key in fields) if (fields[key] === undefined) delete fields[key];
  return fields;
}
