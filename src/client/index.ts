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
import { base64urlEncode } from "../shared/base64url.js";
import { serializeNotification, type PushNotification } from "../shared/notification.js";
import type {
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
export { vNotificationResult, vWebPushSubscription } from "../shared/validators.js";
export type { PushNotification } from "../shared/notification.js";
export type { NotificationResult, Urgency, WebPushSubscription };

type RunQuery = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type RunMutation = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
type RunAction = Pick<GenericActionCtx<GenericDataModel>, "runAction">;

/** Component document ids cross the component boundary as plain strings. */
export type NotificationId = string;

export type WebPushOptions = {
  /**
   * Opt in to test mode: record sends without calling push services. Off by default. Without it
   * (and without `WEB_PUSH_TEST_MODE=true` in the component env), sending with missing or invalid
   * VAPID settings throws `WEB_PUSH_NOT_CONFIGURED`.
   */
  testMode?: boolean | undefined;
  /** Extra push service hosts to allow, exact (`push.example.com`) or wildcard (`*.example.com`). */
  allowedPushHosts?: string[] | undefined;
};

export type SendOptions = {
  /** Seconds the push service may hold the message. Default 86400, clamped to 0..2419200. */
  ttl?: number | undefined;
  urgency?: Urgency | undefined;
  /** Replaces a pending message with the same topic: 1-32 characters of A-Z a-z 0-9 _ -. */
  topic?: string | undefined;
  /** Repeating a send with the same key for the same user returns the original notification. */
  idempotencyKey?: string | undefined;
  /** Internal mutation in your app, called with {@link NotificationResult} once every delivery finished. */
  onComplete?:
    | FunctionReference_future<"mutation", "internal", NotificationResult, unknown>
    | undefined;
};

export class WebPush {
  constructor(
    private readonly component: ComponentApi,
    private readonly options: WebPushOptions = {},
  ) {}

  /** Stores a browser subscription for `userId`. Throws `WEB_PUSH_INVALID_SUBSCRIPTION` if invalid. */
  recordSubscription(
    ctx: RunMutation,
    args: { userId: string; subscription: WebPushSubscription; userAgent?: string | undefined },
  ) {
    return ctx.runMutation(this.component.subscriptions.record, {
      ...args,
      ...(this.options.allowedPushHosts !== undefined && {
        allowedPushHosts: this.options.allowedPushHosts,
      }),
    });
  }

  /**
   * Removes one subscription. The endpoint is a capability URL, so pass `userId` to remove it only
   * when it belongs to that user. Returns whether a subscription was removed.
   */
  removeSubscription(ctx: RunMutation, args: { endpoint: string; userId?: string | undefined }) {
    return ctx.runMutation(this.component.subscriptions.remove, args);
  }

  /**
   * Removes one bounded batch of the user's subscriptions. `removed` counts this batch; when
   * `done` is false, scheduled batches delete the rest.
   */
  removeAllForUser(ctx: RunMutation, args: { userId: string }) {
    return ctx.runMutation(this.component.subscriptions.removeAllForUser, args);
  }

  /** Sends a structured notification to every active subscription of `userId`. Null if there are none. */
  async sendNotification(
    ctx: RunMutation,
    args: { userId: string; notification: PushNotification; options?: SendOptions | undefined },
  ) {
    return ctx.runMutation(this.component.notifications.send, {
      userId: args.userId,
      ...(await this.sendFields(serializeNotification(args.notification), args.options)),
    });
  }

  /**
   * Sends the same notification to up to 100 users in one bounded transaction. When the delivery
   * budget of that transaction runs out, a scheduled continuation handles the remaining users, so
   * `done` can be false; follow progress with `getBatch`. For more than 100 users, call this from
   * an action once per slice of 100 users, because each call is its own transaction there.
   */
  async sendNotificationBatch(
    ctx: RunMutation,
    args: { userIds: string[]; notification: PushNotification; options?: SendOptions | undefined },
  ) {
    return ctx.runMutation(this.component.notifications.sendBatch, {
      userIds: args.userIds,
      ...(await this.sendFields(serializeNotification(args.notification), args.options)),
    });
  }

  /** Sends your own payload (string or bytes) for apps with a custom service worker. */
  async sendRaw(
    ctx: RunMutation,
    args: { userId: string; payload: string | Uint8Array; options?: SendOptions | undefined },
  ) {
    const [payload, encoding] =
      typeof args.payload === "string"
        ? ([args.payload, undefined] as const)
        : ([base64urlEncode(args.payload), "base64url"] as const);
    return ctx.runMutation(this.component.notifications.send, {
      userId: args.userId,
      ...(await this.sendFields(payload, args.options, encoding)),
    });
  }

  getNotification(ctx: RunQuery, args: { notificationId: NotificationId }) {
    return ctx.runQuery(this.component.notifications.get, args);
  }

  /** Progress of a batch started by `sendNotificationBatch`. */
  getBatch(ctx: RunQuery, args: { batchId: string }) {
    return ctx.runQuery(this.component.notifications.getBatch, args);
  }

  getDeliveries(ctx: RunQuery, args: { notificationId: NotificationId }) {
    return ctx.runQuery(this.component.deliveries.listForNotification, args);
  }

  getNotificationsForUser(
    ctx: RunQuery,
    args: { userId: string; paginationOpts: PaginationOptions },
  ) {
    return ctx.runQuery(this.component.notifications.listForUser, args);
  }

  getStatusForUser(ctx: RunQuery, args: { userId: string }) {
    return ctx.runQuery(this.component.subscriptions.statusForUser, args);
  }

  /** Pauses the user's active subscriptions. Returns how many were paused. */
  pauseNotifications(ctx: RunMutation, args: { userId: string }) {
    return ctx.runMutation(this.component.subscriptions.pauseForUser, args);
  }

  /** Resumes the user's paused subscriptions. Returns how many were resumed. */
  resumeNotifications(ctx: RunMutation, args: { userId: string }) {
    return ctx.runMutation(this.component.subscriptions.resumeForUser, args);
  }

  /** The VAPID public key to give browsers as `applicationServerKey`. Null when unset. */
  getPublicKey(ctx: RunQuery) {
    return ctx.runQuery(this.component.config.getPublicKey, {});
  }

  /** Runs the WebCrypto self-test inside your deployment. Run it once after deploying. */
  selfTest(ctx: RunAction) {
    return ctx.runAction(this.component.diagnostics.selfTest, {});
  }

  /** Builds the component's send arguments, leaving out every option that is not set. */
  private async sendFields(
    payload: string,
    options: SendOptions | undefined,
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
