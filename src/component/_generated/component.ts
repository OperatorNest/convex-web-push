/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    config: {
      getPublicKey: FunctionReference<
        "query",
        "internal",
        {},
        string | null,
        Name
      >;
    };
    deliveries: {
      listForNotification: FunctionReference<
        "query",
        "internal",
        { notificationId: string; userId: string },
        Array<{
          _creationTime: number;
          _id: string;
          attempts: number;
          createdAt: number;
          error?: {
            code:
              | "WEB_PUSH_NOT_CONFIGURED"
              | "WEB_PUSH_INVALID_ARGUMENT"
              | "WEB_PUSH_INVALID_SUBSCRIPTION"
              | "WEB_PUSH_INVALID_PAYLOAD"
              | "WEB_PUSH_PAYLOAD_TOO_LARGE"
              | "WEB_PUSH_INVALID_TOPIC"
              | "WEB_PUSH_BATCH_TOO_LARGE"
              | "WEB_PUSH_INVALID_VAPID_KEY"
              | "WEB_PUSH_CRYPTO_UNSUPPORTED"
              | "WEB_PUSH_UNSUPPORTED"
              | "WEB_PUSH_PERMISSION_DENIED"
              | "WEB_PUSH_SERVICE_WORKER_FAILED"
              | "WEB_PUSH_BROWSER_FAILED"
              | "WEB_PUSH_SERVICE_FAILED";
            message: string;
            providerStatus?: number;
          };
          errorKind?: string;
          notificationId: string;
          retryAfterMs?: number;
          sentAt?: number;
          status: "queued" | "sending" | "sent" | "failed" | "gone" | "retry";
          statusCode?: number;
          subscriptionId: string;
          subscriptionRevision?: number;
          testMode?: boolean;
          userId: string;
        }>,
        Name
      >;
    };
    diagnostics: {
      selfTest: FunctionReference<
        "action",
        "internal",
        {},
        {
          checks: Array<{ error?: string; name: string; ok: boolean }>;
          config: { configured: boolean; problem?: string };
          ok: boolean;
          testMode: boolean;
        },
        Name
      >;
    };
    notifications: {
      get: FunctionReference<
        "query",
        "internal",
        { notificationId: string; userId: string },
        {
          _creationTime: number;
          _id: string;
          allowedPushHosts?: Array<string>;
          counts: {
            failed: number;
            gone: number;
            queued: number;
            sent: number;
          };
          createdAt: number;
          idempotencyKey?: string;
          onComplete?: string;
          options: {
            topic?: string;
            ttl: number;
            urgency: "very-low" | "low" | "normal" | "high";
          };
          payload: string;
          payloadEncoding?: "base64url";
          status: "queued" | "partial" | "delivered" | "failed";
          testMode?: boolean;
          userId: string;
        } | null,
        Name
      >;
      getBatch: FunctionReference<
        "query",
        "internal",
        { batchId: string },
        {
          errorCode?:
            | "WEB_PUSH_NOT_CONFIGURED"
            | "WEB_PUSH_INVALID_ARGUMENT"
            | "WEB_PUSH_INVALID_SUBSCRIPTION"
            | "WEB_PUSH_INVALID_PAYLOAD"
            | "WEB_PUSH_PAYLOAD_TOO_LARGE"
            | "WEB_PUSH_INVALID_TOPIC"
            | "WEB_PUSH_BATCH_TOO_LARGE"
            | "WEB_PUSH_INVALID_VAPID_KEY"
            | "WEB_PUSH_CRYPTO_UNSUPPORTED"
            | "WEB_PUSH_UNSUPPORTED"
            | "WEB_PUSH_PERMISSION_DENIED"
            | "WEB_PUSH_SERVICE_WORKER_FAILED"
            | "WEB_PUSH_BROWSER_FAILED"
            | "WEB_PUSH_SERVICE_FAILED";
          notificationIds: Array<string>;
          processed: number;
          status: "running" | "done" | "failed";
          total: number;
        } | null,
        Name
      >;
      listForUser: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          userId: string;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: string;
            allowedPushHosts?: Array<string>;
            counts: {
              failed: number;
              gone: number;
              queued: number;
              sent: number;
            };
            createdAt: number;
            idempotencyKey?: string;
            onComplete?: string;
            options: {
              topic?: string;
              ttl: number;
              urgency: "very-low" | "low" | "normal" | "high";
            };
            payload: string;
            payloadEncoding?: "base64url";
            status: "queued" | "partial" | "delivered" | "failed";
            testMode?: boolean;
            userId: string;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      send: FunctionReference<
        "mutation",
        "internal",
        {
          allowedPushHosts?: Array<string>;
          idempotencyKey?: string;
          onComplete?: string;
          payload: string;
          payloadEncoding?: "base64url";
          testMode?: boolean;
          topic?: string;
          ttl?: number;
          urgency?: "very-low" | "low" | "normal" | "high";
          userId: string;
        },
        string | null,
        Name
      >;
      sendBatch: FunctionReference<
        "mutation",
        "internal",
        {
          allowedPushHosts?: Array<string>;
          idempotencyKey?: string;
          onComplete?: string;
          payload: string;
          payloadEncoding?: "base64url";
          testMode?: boolean;
          topic?: string;
          ttl?: number;
          urgency?: "very-low" | "low" | "normal" | "high";
          userIds: Array<string>;
        },
        {
          batchId: string;
          done: boolean;
          results: Array<{ notificationId: string | null; userId: string }>;
        },
        Name
      >;
    };
    subscriptions: {
      pauseForUser: FunctionReference<
        "mutation",
        "internal",
        { userId: string },
        number,
        Name
      >;
      record: FunctionReference<
        "mutation",
        "internal",
        {
          allowedPushHosts?: Array<string>;
          subscription: {
            endpoint: string;
            expirationTime?: number | null;
            keys: { auth: string; p256dh: string };
          };
          userAgent?: string;
          userId: string;
        },
        { created: boolean; subscriptionId: string },
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { endpoint: string; userId: string },
        boolean,
        Name
      >;
      removeAllForUser: FunctionReference<
        "mutation",
        "internal",
        { userId: string },
        { done: boolean; removed: number },
        Name
      >;
      resumeForUser: FunctionReference<
        "mutation",
        "internal",
        { userId: string },
        number,
        Name
      >;
      statusForUser: FunctionReference<
        "query",
        "internal",
        { userId: string },
        { lastSuccessAt?: number; paused: number; subscriptions: number },
        Name
      >;
    };
  };
