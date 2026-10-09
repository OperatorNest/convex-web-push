import { base64urlDecode } from "./base64url.js";
import { classifyPushStatus, MAX_ERROR_DETAIL_CHARS } from "./classify.js";
import { encryptAes128gcm } from "./encrypt.js";
import { isWebPushError } from "./errors.js";
import { checkPushEndpoint } from "./push.js";
import type { SendOutcome, Urgency } from "./validators.js";
import { signVapidJwt, vapidAuthorization } from "./vapid.js";

const SEND_TIMEOUT_MS = 10_000;

export type SendWebPushInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** Null sends an empty "tickle" push with no body. */
  payload: Uint8Array | null;
  ttl: number;
  urgency: Urgency;
  topic?: string | undefined;
  allowedPushHosts?: readonly string[] | undefined;
  vapid: { publicKey: string; subject: string; privateKey: CryptoKey };
  now?: number | undefined;
};

function failure(error: unknown): SendOutcome {
  if (isWebPushError(error)) {
    // "WEB_PUSH_INVALID_SUBSCRIPTION" becomes the delivery errorKind "invalid_subscription".
    const errorKind = error.data.code.slice("WEB_PUSH_".length).toLowerCase();
    return { kind: "permanent", errorKind, detail: error.data.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  const hint = /not implemented|not supported/i.test(message)
    ? " The Convex backend may not support this WebCrypto operation; upgrade it and run diagnostics.selfTest."
    : "";
  return {
    kind: "permanent",
    errorKind: "crypto_error",
    detail: `${message.slice(0, 120)}${hint}`,
  };
}

/** Encrypts, signs and POSTs one push message, then classifies the result. Never throws. */
export async function sendWebPush(input: SendWebPushInput): Promise<SendOutcome> {
  const check = checkPushEndpoint(input.endpoint, input.allowedPushHosts);
  if (!check.ok)
    return { kind: "permanent", errorKind: "endpoint_not_allowed", detail: check.reason };

  const headers: Record<string, string> = {
    TTL: String(input.ttl),
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
    if (outcome.kind === "sent") {
      await response.body?.cancel();
    } else {
      const text = await response.text().catch(() => "");
      if (text) outcome.detail = text.slice(0, MAX_ERROR_DETAIL_CHARS);
    }
    return outcome;
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      kind: "retryable",
      errorKind: aborted ? "timeout" : "network_error",
      detail: aborted ? "Push service did not respond in time" : String(error).slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}
