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
      get: FunctionReference<
        "query",
        "internal",
        { testMode?: boolean },
        { applicationServerKey: string | null },
        Name
      >;
      verify: FunctionReference<
        "action",
        "internal",
        { testMode?: boolean },
        {
          checks: Array<{ error?: string; name: string; ok: boolean }>;
          config: { configured: boolean; problem?: string };
          ok: boolean;
          testMode: boolean;
        },
        Name
      >;
    };
    deliveries: {
      list: FunctionReference<
        "query",
        "internal",
        { notificationId: string; testMode?: boolean; userId: string },
        Array<{
          _creationTime: number;
          _id: string;
          attempts: number;
          createdAt: number;
          error?: {
            code:
              | "WEB_PUSH_NOT_CONFIGURED"
              | "WEB_PUSH_INVALID_ARGUMENT"
              | "WEB_PUSH_NOT_FOUND"
              | "WEB_PUSH_IDEMPOTENCY_CONFLICT"
              | "WEB_PUSH_PROVIDER_ERROR"
              | "WEB_PUSH_NETWORK_ERROR"
              | "WEB_PUSH_PAYLOAD_TOO_LARGE"
              | "WEB_PUSH_CRYPTO_UNSUPPORTED"
              | "WEB_PUSH_UNSUPPORTED"
              | "WEB_PUSH_PERMISSION_DENIED"
              | "WEB_PUSH_SERVICE_WORKER_FAILED"
              | "WEB_PUSH_BROWSER_FAILED";
            message: string;
            providerCode?: string;
            providerStatus?: number;
            retryable?: boolean;
          };
          errorKind?:
            | "delivery_closed"
            | "notification_missing"
            | "subscription_removed"
            | "reassigned"
            | "subscription_gone"
            | "subscription_expired"
            | "subscription_paused"
            | "ttl_expired"
            | "vapid_not_configured"
            | "vapid_key_mismatch"
            | "invalid_vapid_key"
            | "endpoint_not_allowed"
            | "payload_too_large"
            | "invalid_subscription_keys"
            | "crypto_unsupported"
            | "timeout"
            | "network_error"
            | "rate_limited"
            | "server_error"
            | "vapid_rejected"
            | "unexpected_redirect"
            | "bad_request"
            | "invalid_result"
            | "action_failed"
            | "canceled"
            | "max_attempts";
          notificationId: string;
          providerStatus?: number;
          retryAfterMs?: number;
          sentAt?: number;
          status: "queued" | "sending" | "sent" | "failed" | "gone" | "retry";
          subscriptionId: string;
          subscriptionRevision?: number;
          testMode: boolean;
          userId: string;
        }>,
        Name
      >;
    };
    notifications: {
      get: FunctionReference<
        "query",
        "internal",
        { notificationId: string; testMode?: boolean; userId: string },
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
            ttlSeconds: number;
            urgency: "very-low" | "low" | "normal" | "high";
          };
          payload: string;
          payloadEncoding?: "base64url";
          status: "queued" | "partial" | "delivered" | "failed";
          testMode: boolean;
          userId: string;
        },
        Name
      >;
      getBatch: FunctionReference<
        "query",
        "internal",
        { batchId: string; testMode?: boolean },
        {
          errorCode?:
            | "WEB_PUSH_NOT_CONFIGURED"
            | "WEB_PUSH_INVALID_ARGUMENT"
            | "WEB_PUSH_NOT_FOUND"
            | "WEB_PUSH_IDEMPOTENCY_CONFLICT"
            | "WEB_PUSH_PROVIDER_ERROR"
            | "WEB_PUSH_NETWORK_ERROR"
            | "WEB_PUSH_PAYLOAD_TOO_LARGE"
            | "WEB_PUSH_CRYPTO_UNSUPPORTED"
            | "WEB_PUSH_UNSUPPORTED"
            | "WEB_PUSH_PERMISSION_DENIED"
            | "WEB_PUSH_SERVICE_WORKER_FAILED"
            | "WEB_PUSH_BROWSER_FAILED";
          notificationIds: Array<string>;
          processed: number;
          status: "running" | "done" | "failed";
          total: number;
        },
        Name
      >;
      list: FunctionReference<
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
          testMode?: boolean;
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
              ttlSeconds: number;
              urgency: "very-low" | "low" | "normal" | "high";
            };
            payload: string;
            payloadEncoding?: "base64url";
            status: "queued" | "partial" | "delivered" | "failed";
            testMode: boolean;
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
          ttlSeconds: number;
          urgency: "very-low" | "low" | "normal" | "high";
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
          ttlSeconds: number;
          urgency: "very-low" | "low" | "normal" | "high";
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
      getStatus: FunctionReference<
        "query",
        "internal",
        { testMode?: boolean; userId: string },
        { activeCount: number; lastSuccessAt?: number; pausedCount: number },
        Name
      >;
      pause: FunctionReference<
        "mutation",
        "internal",
        { testMode?: boolean; userId: string },
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
          testMode?: boolean;
          userAgent?: string;
          userId: string;
        },
        { created: boolean; subscriptionId: string },
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { endpoint: string; testMode?: boolean; userId: string },
        boolean,
        Name
      >;
      removeAll: FunctionReference<
        "mutation",
        "internal",
        { testMode?: boolean; userId: string },
        { done: boolean; removed: number },
        Name
      >;
      resume: FunctionReference<
        "mutation",
        "internal",
        { testMode?: boolean; userId: string },
        number,
        Name
      >;
    };
  };
