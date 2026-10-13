import { utf8ByteLength } from "./base64url.js";
import { MAX_PLAINTEXT_BYTES } from "./encrypt.js";
import { webPushError } from "./errors.js";

export type PushNotification = {
  title: string;
  body?: string;
  icon?: string;
  badge?: string;
  image?: string;

  url?: string;
  tag?: string;
  renotify?: boolean;
  requireInteraction?: boolean;
  silent?: boolean;
  timestamp?: number;
  actions?: { action: string; title: string; icon?: string }[];

  data?: unknown;
};

export function serializeNotification(notification: PushNotification): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(notification);
  } catch {
    throw webPushError("WEB_PUSH_INVALID_PAYLOAD");
  }
  if (typeof json !== "string") throw webPushError("WEB_PUSH_INVALID_PAYLOAD");
  assertPayloadSize(utf8ByteLength(json));
  return json;
}

export function assertPayloadSize(bytes: number): void {
  if (bytes > MAX_PLAINTEXT_BYTES) {
    throw webPushError("WEB_PUSH_PAYLOAD_TOO_LARGE");
  }
}
