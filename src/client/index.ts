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
  BatchResult,
  NotificationResult,
  SendFields,
  Urgency,
  WebPushSubscription,
} from "../shared/validators.js";

export { generateVapidKeys, type VapidKeys } from "../shared/vapid.js";
export { MAX_PLAINTEXT_BYTES } from "../shared/encrypt.js";
export {
  WEB_PUSH_ERROR_CODES,
  isWebPushError,
  type WebPushErrorCode,
  type WebPushErrorData,
} from "../shared/errors.js";
export { vBatchResult, vNotificationResult, vWebPushSubscription } from "../shared/validators.js";
export type { PushNotification } from "../shared/notification.js";
export type { BatchResult, NotificationResult, Urgency, WebPushSubscription };

type RunQuery = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type RunMutation = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
type RunAction = Pick<GenericActionCtx<GenericDataModel>, "runAction">;

export type NotificationId = string;

export type WebPushOptions = {
  testMode?: boolean | undefined;

  allowedPushHosts?: string[] | undefined;
};

export type SendOptions = {
  ttl?: number | undefined;
  urgency?: Urgency | undefined;

  topic?: string | undefined;

  idempotencyKey?: string | undefined;

  onComplete?:
    | FunctionReference_future<"mutation", "internal", NotificationResult, unknown>
    | undefined;
};

export type BatchSendOptions = Omit<SendOptions, "onComplete"> & {
  onComplete?: FunctionReference_future<"mutation", "internal", BatchResult, unknown> | undefined;
};

export class WebPush {
  constructor(
    private readonly component: ComponentApi,
    private readonly options: WebPushOptions = {},
  ) {}

  recordSubscription(
    ctx: RunMutation,
    args: { userId: string; subscription: WebPushSubscription; userAgent?: string | undefined },
  ) {
    return ctx.runMutation(
      this.component.subscriptions.record,
      definedFields({
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
  }

  removeSubscription(ctx: RunMutation, args: { endpoint: string; userId: string }) {
    return ctx.runMutation(
      this.component.subscriptions.remove,
      definedFields({ endpoint: args.endpoint, userId: args.userId }),
    );
  }

  removeAllForUser(ctx: RunMutation, args: { userId: string }) {
    return ctx.runMutation(
      this.component.subscriptions.removeAllForUser,
      definedFields({ userId: args.userId }),
    );
  }

  async sendNotification(
    ctx: RunMutation,
    args: { userId: string; notification: PushNotification; options?: SendOptions | undefined },
  ) {
    const fields = await this.sendFields(serializeNotification(args.notification), args.options);
    return ctx.runMutation(
      this.component.notifications.send,
      definedFields({
        userId: args.userId,
        payload: fields.payload,
        payloadEncoding: fields.payloadEncoding,
        ttl: fields.ttl,
        urgency: fields.urgency,
        topic: fields.topic,
        idempotencyKey: fields.idempotencyKey,
        onComplete: fields.onComplete,
        testMode: fields.testMode,
        allowedPushHosts: fields.allowedPushHosts,
      }),
    );
  }

  async sendNotificationBatch(
    ctx: RunMutation,
    args: {
      userIds: string[];
      notification: PushNotification;
      options?: BatchSendOptions | undefined;
    },
  ) {
    const fields = await this.sendFields(serializeNotification(args.notification), args.options);
    return ctx.runMutation(
      this.component.notifications.sendBatch,
      definedFields({
        userIds: args.userIds,
        payload: fields.payload,
        payloadEncoding: fields.payloadEncoding,
        ttl: fields.ttl,
        urgency: fields.urgency,
        topic: fields.topic,
        idempotencyKey: fields.idempotencyKey,
        onComplete: fields.onComplete,
        testMode: fields.testMode,
        allowedPushHosts: fields.allowedPushHosts,
      }),
    );
  }

  async sendRaw(
    ctx: RunMutation,
    args: { userId: string; payload: string | Uint8Array; options?: SendOptions | undefined },
  ) {
    assertPayloadSize(
      typeof args.payload === "string" ? utf8ByteLength(args.payload) : args.payload.byteLength,
    );
    const [payload, encoding] =
      typeof args.payload === "string"
        ? ([args.payload, undefined] as const)
        : ([base64urlEncode(args.payload), "base64url"] as const);
    const fields = await this.sendFields(payload, args.options, encoding);
    return ctx.runMutation(
      this.component.notifications.send,
      definedFields({
        userId: args.userId,
        payload: fields.payload,
        payloadEncoding: fields.payloadEncoding,
        ttl: fields.ttl,
        urgency: fields.urgency,
        topic: fields.topic,
        idempotencyKey: fields.idempotencyKey,
        onComplete: fields.onComplete,
        testMode: fields.testMode,
        allowedPushHosts: fields.allowedPushHosts,
      }),
    );
  }

  getNotification(ctx: RunQuery, args: { notificationId: NotificationId; userId: string }) {
    return ctx.runQuery(
      this.component.notifications.get,
      definedFields({ notificationId: args.notificationId, userId: args.userId }),
    );
  }

  getBatch(ctx: RunQuery, args: { batchId: string }) {
    return ctx.runQuery(
      this.component.notifications.getBatch,
      definedFields({ batchId: args.batchId }),
    );
  }

  getDeliveries(ctx: RunQuery, args: { notificationId: NotificationId; userId: string }) {
    return ctx.runQuery(
      this.component.deliveries.listForNotification,
      definedFields({ notificationId: args.notificationId, userId: args.userId }),
    );
  }

  getNotificationsForUser(
    ctx: RunQuery,
    args: { userId: string; paginationOpts: PaginationOptions },
  ) {
    return ctx.runQuery(
      this.component.notifications.listForUser,
      definedFields({
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
  }

  getStatusForUser(ctx: RunQuery, args: { userId: string }) {
    return ctx.runQuery(
      this.component.subscriptions.statusForUser,
      definedFields({ userId: args.userId }),
    );
  }

  pauseNotifications(ctx: RunMutation, args: { userId: string }) {
    return ctx.runMutation(
      this.component.subscriptions.pauseForUser,
      definedFields({ userId: args.userId }),
    );
  }

  resumeNotifications(ctx: RunMutation, args: { userId: string }) {
    return ctx.runMutation(
      this.component.subscriptions.resumeForUser,
      definedFields({ userId: args.userId }),
    );
  }

  getPublicKey(ctx: RunQuery) {
    return ctx.runQuery(this.component.config.getPublicKey, definedFields({}));
  }

  selfTest(ctx: RunAction) {
    return ctx.runAction(this.component.diagnostics.selfTest, definedFields({}));
  }

  private async sendFields<Result extends NotificationResult | BatchResult>(
    payload: string,
    options:
      | (Omit<SendOptions, "onComplete"> & {
          onComplete?:
            | FunctionReference_future<"mutation", "internal", Result, unknown>
            | undefined;
        })
      | undefined,
    payloadEncoding?: "base64url",
  ): Promise<SendFields> {
    return {
      payload,
      ...(payloadEncoding !== undefined && { payloadEncoding }),
      ...(options?.ttl !== undefined && { ttl: options.ttl }),
      ...(options?.urgency !== undefined && { urgency: options.urgency }),
      ...(options?.topic !== undefined && { topic: options.topic }),
      ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      ...(options?.onComplete !== undefined && {
        onComplete: await createFunctionHandle(options.onComplete),
      }),
      ...(this.options.testMode !== undefined && { testMode: this.options.testMode }),
      ...(this.options.allowedPushHosts !== undefined && {
        allowedPushHosts: this.options.allowedPushHosts,
      }),
    };
  }
}

function definedFields<T extends object>(fields: T): T {
  for (const key in fields) if (fields[key] === undefined) delete fields[key];
  return fields;
}
