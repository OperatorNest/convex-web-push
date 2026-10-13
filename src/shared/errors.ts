import { ConvexError } from "convex/values";

export const WEB_PUSH_ERROR_CODES = [
  "WEB_PUSH_NOT_CONFIGURED",
  "WEB_PUSH_INVALID_ARGUMENT",
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
  "WEB_PUSH_BROWSER_FAILED",
  "WEB_PUSH_SERVICE_FAILED",
] as const;

export type WebPushErrorCode = (typeof WEB_PUSH_ERROR_CODES)[number];
export type WebPushErrorData = { code: WebPushErrorCode; message: string; providerStatus?: number };

export const WEB_PUSH_ERROR_MESSAGES = {
  WEB_PUSH_NOT_CONFIGURED:
    "VAPID settings are missing or invalid, changed during a batch, or WEB_PUSH_MAX_PARALLELISM is invalid.",
  WEB_PUSH_INVALID_ARGUMENT: "An argument is empty, malformed or outside its bounds.",
  WEB_PUSH_INVALID_SUBSCRIPTION:
    "The endpoint, P-256 public key, auth secret or expiration is invalid.",
  WEB_PUSH_INVALID_PAYLOAD:
    "The notification cannot be serialized to JSON or the raw payload is malformed base64url.",
  WEB_PUSH_PAYLOAD_TOO_LARGE:
    "The plaintext exceeds 3993 bytes or the encoded input exceeds 5324 UTF-16 code units.",
  WEB_PUSH_INVALID_TOPIC: "The topic must contain 1 to 32 characters from A-Z, a-z, 0-9, _ or -.",
  WEB_PUSH_BATCH_TOO_LARGE: "A batch must contain at most 100 supplied user IDs.",
  WEB_PUSH_INVALID_VAPID_KEY:
    "The VAPID keys are malformed, cannot be imported or do not form a matching pair.",
  WEB_PUSH_CRYPTO_UNSUPPORTED: "The runtime cannot complete the required WebCrypto operation.",
  WEB_PUSH_UNSUPPORTED: "Web Push is unavailable in this browser.",
  WEB_PUSH_PERMISSION_DENIED: "Notification permission was not granted.",
  WEB_PUSH_SERVICE_WORKER_FAILED:
    "A service worker operation failed; verify its scope and notification options.",
  WEB_PUSH_BROWSER_FAILED: "The browser could not complete the push subscription operation.",
  WEB_PUSH_SERVICE_FAILED: "The push attempt failed or the subscription is no longer eligible.",
} as const satisfies Record<WebPushErrorCode, string>;

export function webPushError(
  code: WebPushErrorCode,
  providerStatus?: number,
): ConvexError<WebPushErrorData> {
  return new ConvexError({
    code,
    message: WEB_PUSH_ERROR_MESSAGES[code],
    ...(providerStatus !== undefined && { providerStatus }),
  });
}

export function isWebPushError(error: unknown): error is ConvexError<WebPushErrorData> {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    "code" in data &&
    "message" in data &&
    typeof data.message === "string" &&
    WEB_PUSH_ERROR_CODES.some((code) => code === data.code) &&
    (!("providerStatus" in data) ||
      (typeof data.providerStatus === "number" &&
        Number.isInteger(data.providerStatus) &&
        data.providerStatus >= 100 &&
        data.providerStatus <= 599))
  );
}
