import { ConvexError } from "convex/values";
import { truncateText } from "./bounds.js";

export const WEB_PUSH_ERROR_CODES = [
  "WEB_PUSH_NOT_CONFIGURED",
  "WEB_PUSH_INVALID_ARGUMENT",
  "WEB_PUSH_NOT_FOUND",
  "WEB_PUSH_IDEMPOTENCY_CONFLICT",
  "WEB_PUSH_PROVIDER_ERROR",
  "WEB_PUSH_NETWORK_ERROR",
  "WEB_PUSH_PAYLOAD_TOO_LARGE",
  "WEB_PUSH_CRYPTO_UNSUPPORTED",
  "WEB_PUSH_UNSUPPORTED",
  "WEB_PUSH_PERMISSION_DENIED",
  "WEB_PUSH_SERVICE_WORKER_FAILED",
  "WEB_PUSH_BROWSER_FAILED",
] as const;

/** A Web Push error code identifies a fixed caller-visible failure. */
export type WebPushErrorCode = (typeof WEB_PUSH_ERROR_CODES)[number];
/** Web Push error data contains a fixed message and bounded provider failure details. */
export type WebPushErrorData = {
  code: WebPushErrorCode;
  message: string;
  retryable?: boolean;
  providerStatus?: number;
  providerCode?: string;
};

const WEB_PUSH_ERROR_MESSAGES = {
  WEB_PUSH_NOT_CONFIGURED:
    "Component configuration is missing, malformed or changed during a batch.",
  WEB_PUSH_INVALID_ARGUMENT: "An argument is empty, malformed or outside its bounds.",
  WEB_PUSH_NOT_FOUND: "The referenced row does not exist for this user and test mode.",
  WEB_PUSH_IDEMPOTENCY_CONFLICT: "The idempotency key was reused with different arguments.",
  WEB_PUSH_PROVIDER_ERROR: "The push service rejected the message.",
  WEB_PUSH_NETWORK_ERROR: "The push service request produced no response.",
  WEB_PUSH_PAYLOAD_TOO_LARGE:
    "The plaintext exceeds 3993 bytes or the encoded input exceeds 5324 UTF-16 code units.",
  WEB_PUSH_CRYPTO_UNSUPPORTED: "The runtime cannot complete the required WebCrypto operation.",
  WEB_PUSH_UNSUPPORTED: "Web Push is unavailable in this browser.",
  WEB_PUSH_PERMISSION_DENIED: "Notification permission was not granted.",
  WEB_PUSH_SERVICE_WORKER_FAILED:
    "A service worker operation failed; verify its scope and notification options.",
  WEB_PUSH_BROWSER_FAILED: "The browser could not complete the push subscription operation.",
} as const satisfies Record<WebPushErrorCode, string>;

export function webPushError(
  code: WebPushErrorCode,
  details?: Pick<WebPushErrorData, "retryable" | "providerStatus" | "providerCode">,
): ConvexError<WebPushErrorData> {
  return new ConvexError({
    code,
    message: WEB_PUSH_ERROR_MESSAGES[code],
    ...((code === "WEB_PUSH_PROVIDER_ERROR" || code === "WEB_PUSH_NETWORK_ERROR") &&
      details?.retryable !== undefined && { retryable: details.retryable }),
    ...(details?.providerStatus !== undefined && { providerStatus: details.providerStatus }),
    ...(details?.providerCode !== undefined && {
      providerCode: truncateText(details.providerCode, 64),
    }),
  });
}

/** Recognize fixed Web Push errors with valid provider failure details. */
export function isWebPushError(error: unknown): error is ConvexError<WebPushErrorData> {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    "code" in data &&
    "message" in data &&
    typeof data.message === "string" &&
    WEB_PUSH_ERROR_CODES.some(
      (code) => code === data.code && data.message === WEB_PUSH_ERROR_MESSAGES[code],
    ) &&
    (!("retryable" in data) ||
      ((data.code === "WEB_PUSH_PROVIDER_ERROR" || data.code === "WEB_PUSH_NETWORK_ERROR") &&
        typeof data.retryable === "boolean")) &&
    (!("providerCode" in data) ||
      (typeof data.providerCode === "string" &&
        data.providerCode.isWellFormed() &&
        data.providerCode.length <= 64)) &&
    (!("providerStatus" in data) ||
      (typeof data.providerStatus === "number" &&
        Number.isInteger(data.providerStatus) &&
        data.providerStatus >= 100 &&
        data.providerStatus <= 599))
  );
}
