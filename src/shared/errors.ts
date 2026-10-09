import { ConvexError } from "convex/values";

export const WEB_PUSH_ERROR_CODES = [
  "WEB_PUSH_NOT_CONFIGURED",
  "WEB_PUSH_INVALID_SUBSCRIPTION",
  "WEB_PUSH_INVALID_PAYLOAD",
  "WEB_PUSH_PAYLOAD_TOO_LARGE",
  "WEB_PUSH_INVALID_TOPIC",
  "WEB_PUSH_BATCH_TOO_LARGE",
  "WEB_PUSH_INVALID_VAPID_KEY",
  "WEB_PUSH_CRYPTO_UNSUPPORTED",
  "WEB_PUSH_UNSUPPORTED",
  "WEB_PUSH_PERMISSION_DENIED",
  "WEB_PUSH_SERVICE_WORKER_FAILED",
] as const;

export type WebPushErrorCode = (typeof WEB_PUSH_ERROR_CODES)[number];

/** The `data` of every error this package throws. Messages never contain key material. */
export type WebPushErrorData = {
  code: WebPushErrorCode;
  message: string;
  retryable?: boolean;
};

/** The one place errors are built. Everything thrown on a caller-reachable path comes from here. */
export function webPushError(
  code: WebPushErrorCode,
  message: string,
  retryable?: boolean,
): ConvexError<WebPushErrorData> {
  return new ConvexError(
    retryable === undefined ? { code, message } : { code, message, retryable },
  );
}

function isCode(value: unknown): value is WebPushErrorCode {
  return WEB_PUSH_ERROR_CODES.some((code) => code === value);
}

/** Narrows an unknown caught value to a Web Push error and its typed `data`. */
export function isWebPushError(error: unknown): error is ConvexError<WebPushErrorData> {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  return typeof data === "object" && data !== null && "code" in data && isCode(data.code);
}
