import { ConvexError } from "convex/values";
import { truncateText } from "./bounds.js";

// repository-codes:begin
/** Every error code that package functions raise in `ConvexError` data. */
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

const WEB_PUSH_PROVIDER_ERROR_CODES = [
  "WEB_PUSH_PROVIDER_ERROR",
  "WEB_PUSH_NETWORK_ERROR",
] as const satisfies readonly WebPushErrorCode[];

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
// repository-codes:end

const ERROR_DATA_KEYS: ReadonlySet<string> = new Set([
  "code",
  "message",
  "retryable",
  "providerStatus",
  "providerCode",
]);

/** One fixed caller-visible failure; `WEB_PUSH_ERROR_CODES` lists every code. */
export type WebPushErrorCode = (typeof WEB_PUSH_ERROR_CODES)[number];

/** Error data: the code, its fixed message and bounded provider failure details. `retryable` is present exactly on provider-originated codes. */
export type WebPushErrorData = {
  code: WebPushErrorCode;
  message: string;
  retryable?: boolean;
  providerStatus?: number;
  providerCode?: string;
};

type ProviderErrorCode = (typeof WEB_PUSH_PROVIDER_ERROR_CODES)[number];

type ErrorDetails<Code extends WebPushErrorCode> = [Code] extends [
  Exclude<WebPushErrorCode, ProviderErrorCode>,
]
  ? [details?: { retryable?: never; providerStatus?: number; providerCode?: string }]
  : [details: { retryable: boolean; providerStatus?: number; providerCode?: string }];

function isProviderErrorCode(code: unknown): code is ProviderErrorCode {
  return WEB_PUSH_PROVIDER_ERROR_CODES.some((candidate) => candidate === code);
}

/** Creates the error for `code` with its fixed message. Provider-originated codes require `details.retryable`; other codes forbid it. `providerCode` is truncated to 64 characters. */
export function webPushError<Code extends WebPushErrorCode>(
  code: Code,
  ...[details]: ErrorDetails<Code>
): ConvexError<WebPushErrorData> {
  return new ConvexError({
    code,
    message: WEB_PUSH_ERROR_MESSAGES[code],
    ...(isProviderErrorCode(code) &&
      details?.retryable !== undefined && { retryable: details.retryable }),
    ...(details?.providerStatus !== undefined && { providerStatus: details.providerStatus }),
    ...(details?.providerCode !== undefined && {
      providerCode: truncateText(details.providerCode, 64),
    }),
  });
}

/** Returns true when `error` carries exactly a known code, its fixed message, `retryable` on provider-originated codes only, and well-formed provider details. */
export function isWebPushError(error: unknown): error is ConvexError<WebPushErrorData> {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null || !("code" in data) || !("message" in data))
    return false;
  const { code, message } = data;
  return (
    Object.keys(data).every((key) => ERROR_DATA_KEYS.has(key)) &&
    WEB_PUSH_ERROR_CODES.some(
      (candidate) => candidate === code && message === WEB_PUSH_ERROR_MESSAGES[candidate],
    ) &&
    ("retryable" in data
      ? isProviderErrorCode(code) && typeof data.retryable === "boolean"
      : !isProviderErrorCode(code)) &&
    (!("providerStatus" in data) ||
      (typeof data.providerStatus === "number" &&
        Number.isInteger(data.providerStatus) &&
        data.providerStatus >= 100 &&
        data.providerStatus <= 599)) &&
    (!("providerCode" in data) ||
      (typeof data.providerCode === "string" &&
        data.providerCode.isWellFormed() &&
        data.providerCode.length <= 64))
  );
}
