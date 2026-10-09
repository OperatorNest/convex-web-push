import { utf8ByteLength } from "./base64url.js";
import { MAX_PLAINTEXT_BYTES } from "./encrypt.js";
import { webPushError } from "./errors.js";

/**
 * Payload shape understood by the `/sw` handlers and the bundled service worker. Apps that need a
 * different shape use `sendRaw` with their own service worker.
 */
export type PushNotification = {
  title: string;
  body?: string;
  icon?: string;
  badge?: string;
  image?: string;
  /** Same-origin URL opened when the notification is clicked. */
  url?: string;
  tag?: string;
  renotify?: boolean;
  requireInteraction?: boolean;
  silent?: boolean;
  timestamp?: number;
  actions?: { action: string; title: string; icon?: string }[];
  /** Arbitrary JSON-serializable data, forwarded to the notification as `data.extra`. */
  data?: unknown;
};

export function serializeNotification(notification: PushNotification): string {
  let json: string;
  try {
    json = JSON.stringify(notification);
  } catch {
    // BigInt values, circular references and throwing `toJSON` methods all end up here.
    throw webPushError("WEB_PUSH_INVALID_PAYLOAD", "The notification cannot be serialized to JSON");
  }
  assertPayloadSize(utf8ByteLength(json));
  return json;
}

function assertPayloadSize(bytes: number): void {
  if (bytes > MAX_PLAINTEXT_BYTES) {
    throw webPushError(
      "WEB_PUSH_PAYLOAD_TOO_LARGE",
      `Payload is ${bytes} bytes; the maximum is ${MAX_PLAINTEXT_BYTES}`,
    );
  }
}
