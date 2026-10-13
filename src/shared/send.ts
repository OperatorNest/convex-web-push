import { base64urlDecode } from "./base64url.js";
import { readBoundedText } from "./bounds.js";
import { classifyPushStatus } from "./classify.js";
import { encryptAes128gcm } from "./encrypt.js";
import { isWebPushError, webPushError, type WebPushErrorCode } from "./errors.js";
import { checkPushEndpoint } from "./push.js";
import type { DeliveryErrorKind, SendOutcome, Urgency } from "./validators.js";
import { signVapidJwt, vapidAuthorization } from "./vapid.js";

const SEND_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 4096;

/** A push request carries its subscription, plaintext, delivery options and imported VAPID signing key. */
export type SendWebPushInput = {
  endpoint: string;
  p256dh: string;
  auth: string;

  payload: Uint8Array | null;
  ttlSeconds: number;
  urgency: Urgency;
  topic?: string | undefined;
  allowedPushHosts?: readonly string[] | undefined;
  vapid: { publicKey: string; subject: string; privateKey: CryptoKey };
  now?: number | undefined;
};

const PREPARATION_ERROR_KINDS: Partial<Record<WebPushErrorCode, DeliveryErrorKind>> = {
  WEB_PUSH_PAYLOAD_TOO_LARGE: "payload_too_large",
  WEB_PUSH_INVALID_ARGUMENT: "invalid_subscription_keys",
};

function failure(error: unknown): SendOutcome {
  const data = isWebPushError(error)
    ? error.data
    : webPushError("WEB_PUSH_CRYPTO_UNSUPPORTED").data;
  return {
    kind: "permanent",
    errorKind: PREPARATION_ERROR_KINDS[data.code] ?? "crypto_unsupported",
    error: data,
  };
}

export async function sendWebPush(input: SendWebPushInput): Promise<SendOutcome> {
  const check = checkPushEndpoint(input.endpoint, input.allowedPushHosts);
  if (!check.ok)
    return {
      kind: "permanent",
      errorKind: "endpoint_not_allowed",
      error: webPushError("WEB_PUSH_INVALID_ARGUMENT").data,
    };

  const headers: Record<string, string> = {
    TTL: String(input.ttlSeconds),
    Urgency: input.urgency,
  };
  if (input.topic) headers.Topic = input.topic;
  let body: Uint8Array<ArrayBuffer> | null = null;
  try {
    const jwt = await signVapidJwt({
      audience: check.url.origin,
      subject: input.vapid.subject,
      privateKey: input.vapid.privateKey,
      now: input.now,
    });
    headers.Authorization = vapidAuthorization(jwt, input.vapid.publicKey);
    if (input.payload && input.payload.byteLength > 0) {
      body = await encryptAes128gcm({
        plaintext: input.payload,
        uaPublic: base64urlDecode(input.p256dh),
        authSecret: base64urlDecode(input.auth),
      });
      headers["Content-Encoding"] = "aes128gcm";
      headers["Content-Type"] = "application/octet-stream";
    }
  } catch (error) {
    return failure(error);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(check.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    const outcome = classifyPushStatus(
      response.status,
      response.headers.get("Retry-After"),
      input.now ?? Date.now(),
    );
    await readBoundedText(response, RESPONSE_MAX_BYTES).catch(() => undefined);
    if (outcome.kind !== "sent")
      outcome.error = webPushError("WEB_PUSH_PROVIDER_ERROR", {
        providerStatus: response.status,
        retryable: response.status === 429,
      }).data;
    return { ...outcome, attempted: true };
  } catch {
    const aborted = controller.signal.aborted;
    return {
      kind: "retryable",
      attempted: true,
      errorKind: aborted ? "timeout" : "network_error",
      error: webPushError("WEB_PUSH_NETWORK_ERROR", { retryable: false }).data,
    };
  } finally {
    clearTimeout(timer);
  }
}
