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
  PushSubscriptionJSON,
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
  DELIVERY_ERROR_KINDS,
  deliveryErrorKindValidator,
  webPushBatchCompleteArgsValidator,
  webPushNotificationCompleteArgsValidator,
  pushSubscriptionValidator,
} from "../shared/validators.js";
export type { PushNotification } from "../shared/notification.js";
export type {
  WebPushBatchCompleteArgs,
  WebPushNotificationCompleteArgs,
  Urgency,
  PushSubscriptionJSON,
  PushService,
  DeliveryErrorKind,
  SubscriptionStatus,
  NotificationStatus,
  DeliveryStatus,
  BatchStatus,
} from "../shared/validators.js";

// shared-block:begin
/** Runs component queries; app queries, mutations and actions provide it. */
export type QueryContext = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
/** Runs component mutations; app mutations and actions provide it. */
export type MutationContext = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
/** Runs component actions; app actions provide it. */
export type ActionContext = Pick<GenericActionCtx<GenericDataModel>, "runAction">;
// shared-block:end

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
  /** Creates a client for the mounted component; `options` apply to every call. */
  constructor(
    private readonly component: ComponentApi,
    private readonly options: WebPushOptions = {},
  ) {}

  /** Records, removes, pauses, resumes and reports a user's push subscriptions. */
  readonly subscriptions = {
    /** Record or refresh a push subscription for a user. */
    record: (
      ctx: MutationContext,
      args: { userId: string; subscription: PushSubscriptionJSON; userAgent?: string | undefined },
    ) => {
      return ctx.runMutation(this.component.subscriptions.record, {
        testMode: this.options.testMode,
        userId: args.userId,
        subscription: {
          endpoint: args.subscription.endpoint,
          expirationTime: args.subscription.expirationTime,
          keys: { p256dh: args.subscription.keys.p256dh, auth: args.subscription.keys.auth },
        },
        userAgent: args.userAgent,
        allowedPushHosts: this.options.allowedPushHosts,
      });
    },

    /** Remove a push subscription belonging to the user. */
    remove: (ctx: MutationContext, args: { endpoint: string; userId: string }) => {
      return ctx.runMutation(this.component.subscriptions.remove, {
        testMode: this.options.testMode,
        endpoint: args.endpoint,
        userId: args.userId,
      });
    },

    /** Remove the user’s subscriptions while preserving later registrations. */
    removeAll: (ctx: MutationContext, args: { userId: string }) => {
      return ctx.runMutation(this.component.subscriptions.removeAll, {
        testMode: this.options.testMode,
        userId: args.userId,
      });
    },

    /** Read the user’s subscription at `endpoint`, or null when no subscription at that endpoint belongs to the user. */
    get: (ctx: QueryContext, args: { userId: string; endpoint: string }) => {
      return ctx.runQuery(this.component.subscriptions.get, {
        testMode: this.options.testMode,
        userId: args.userId,
        endpoint: args.endpoint,
      });
    },

    /** Read the user’s active and paused subscription counts; active means recorded and not paused, so a subscription past its `expirationTime` counts as active until the next send marks it gone. */
    getStatus: (ctx: QueryContext, args: { userId: string }) => {
      return ctx.runQuery(this.component.subscriptions.getStatus, {
        testMode: this.options.testMode,
        userId: args.userId,
      });
    },

    /** Pause the user’s active subscriptions. */
    pause: (ctx: MutationContext, args: { userId: string }) => {
      return ctx.runMutation(this.component.subscriptions.pause, {
        testMode: this.options.testMode,
        userId: args.userId,
      });
    },

    /** Resume the user’s paused subscriptions. */
    resume: (ctx: MutationContext, args: { userId: string }) => {
      return ctx.runMutation(this.component.subscriptions.resume, {
        testMode: this.options.testMode,
        userId: args.userId,
      });
    },
  };

  /** Sends, reads and lists push notifications and notification batches. */
  readonly notifications = {
    /** Enqueue a displayed notification for the user’s active subscriptions, or only the active one at `endpoint`. */
    send: async (
      ctx: MutationContext,
      args: {
        userId: string;
        notification: PushNotification;
        endpoint?: string | undefined;
      } & SendOptions,
    ) => {
      const fields = await buildSendFields(
        this.options,
        serializeNotification(args.notification),
        args,
        this.options.onNotificationComplete,
      );
      return ctx.runMutation(this.component.notifications.send, {
        userId: args.userId,
        endpoint: args.endpoint,
        payload: fields.payload,
        payloadEncoding: fields.payloadEncoding,
        ttlSeconds: fields.ttlSeconds,
        urgency: fields.urgency,
        topic: fields.topic,
        idempotencyKey: fields.idempotencyKey,
        onComplete: fields.onComplete,
        testMode: fields.testMode,
        allowedPushHosts: fields.allowedPushHosts,
      });
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
      return ctx.runMutation(this.component.notifications.sendBatch, {
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
      });
    },

    /** Enqueue a raw push message for a custom service worker, optionally only to the active subscription at `endpoint`. */
    sendRaw: async (
      ctx: MutationContext,
      args: {
        userId: string;
        payload: string | Uint8Array;
        endpoint?: string | undefined;
      } & SendOptions,
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
      return ctx.runMutation(this.component.notifications.send, {
        userId: args.userId,
        endpoint: args.endpoint,
        payload: fields.payload,
        payloadEncoding: fields.payloadEncoding,
        ttlSeconds: fields.ttlSeconds,
        urgency: fields.urgency,
        topic: fields.topic,
        idempotencyKey: fields.idempotencyKey,
        onComplete: fields.onComplete,
        testMode: fields.testMode,
        allowedPushHosts: fields.allowedPushHosts,
      });
    },

    /** Read a stored notification belonging to the user. */
    get: (ctx: QueryContext, args: { notificationId: NotificationId; userId: string }) => {
      return ctx.runQuery(this.component.notifications.get, {
        testMode: this.options.testMode,
        notificationId: args.notificationId,
        userId: args.userId,
      });
    },

    /** Read the stored progress of a notification batch. */
    getBatch: (ctx: QueryContext, args: { batchId: string }) => {
      return ctx.runQuery(this.component.notifications.getBatch, {
        testMode: this.options.testMode,
        batchId: args.batchId,
      });
    },

    /** List the user’s stored notifications newest first. */
    list: (ctx: QueryContext, args: { userId: string; paginationOpts: PaginationOptions }) => {
      return ctx.runQuery(this.component.notifications.list, {
        testMode: this.options.testMode,
        userId: args.userId,
        paginationOpts: {
          numItems: args.paginationOpts.numItems,
          cursor: args.paginationOpts.cursor,
          endCursor: args.paginationOpts.endCursor,
        },
      });
    },
  };

  /** Lists delivery attempts for a notification. */
  readonly deliveries = {
    /** List stored delivery attempts for the user’s notification. */
    list: (ctx: QueryContext, args: { notificationId: NotificationId; userId: string }) => {
      return ctx.runQuery(this.component.deliveries.list, {
        testMode: this.options.testMode,
        notificationId: args.notificationId,
        userId: args.userId,
      });
    },
  };

  /** Purges a user’s rows from the component. */
  readonly users = {
    /** Delete the user’s subscriptions, notifications, delivery attempts and registration generation row in bounded steps; registrations and notifications created after the purge began survive. */
    purge: (ctx: MutationContext, args: { userId: string }) => {
      return ctx.runMutation(this.component.users.purge, {
        testMode: this.options.testMode,
        userId: args.userId,
      });
    },
  };

  /** Reads the VAPID application server key and verifies the deployed configuration. */
  readonly config = {
    /** Read the application server public key that browsers pass when subscribing. */
    get: (ctx: QueryContext) => {
      return ctx.runQuery(this.component.config.get, { testMode: this.options.testMode });
    },

    /** Verify WebCrypto operations and the configured VAPID key pair without sending; a configuration problem returns `ok: false` with `config.problem` and never throws. */
    verify: (ctx: ActionContext) => {
      return ctx.runAction(this.component.config.verify, { testMode: this.options.testMode });
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
    payloadEncoding,
    ttlSeconds: options.ttlSeconds,
    urgency: options.urgency,
    topic: options.topic,
    idempotencyKey: options.idempotencyKey,
    onComplete: onComplete === undefined ? undefined : await createFunctionHandle(onComplete),
    testMode: clientOptions.testMode,
    allowedPushHosts: clientOptions.allowedPushHosts,
  };
}
