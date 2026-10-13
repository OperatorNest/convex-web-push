import { webPushError } from "./errors.js";
import { base64urlEncode } from "./base64url.js";
import { parsePrivateKey, parsePublicKey, validateVapidSubject } from "./vapid.js";

export const DEFAULT_MAX_PARALLELISM = 10;

/** Component env values the component reads; each stays an optional string until `readConfig` validates it. */
export type ComponentEnv = {
  readonly WEB_PUSH_VAPID_PUBLIC_KEY?: string;
  readonly WEB_PUSH_VAPID_PRIVATE_KEY?: string;
  readonly WEB_PUSH_VAPID_SUBJECT?: string;
  readonly WEB_PUSH_TEST_MODE?: string;
  readonly WEB_PUSH_MAX_PARALLELISM?: string;
};

/** Parsed configuration carries optional VAPID credentials and bounded parallelism. */
export type WebPushConfig = {
  publicKey?: string;
  privateKey?: string;
  subject?: string;
  maxParallelism: number;
};

/** Validates every supplied component env value; throws `WEB_PUSH_NOT_CONFIGURED` on any malformed value, and `requireVapidConfig` rejects missing VAPID values for live operations. */
export function readConfig(env: ComponentEnv): WebPushConfig {
  const maxParallelism =
    env.WEB_PUSH_MAX_PARALLELISM === undefined
      ? DEFAULT_MAX_PARALLELISM
      : Number(env.WEB_PUSH_MAX_PARALLELISM);
  if (
    !Number.isInteger(maxParallelism) ||
    maxParallelism < 1 ||
    maxParallelism > 200 ||
    (env.WEB_PUSH_MAX_PARALLELISM !== undefined && !/^\d+$/.test(env.WEB_PUSH_MAX_PARALLELISM))
  )
    throw webPushError("WEB_PUSH_NOT_CONFIGURED");
  if (
    env.WEB_PUSH_TEST_MODE !== undefined &&
    env.WEB_PUSH_TEST_MODE !== "true" &&
    env.WEB_PUSH_TEST_MODE !== "false"
  )
    throw webPushError("WEB_PUSH_NOT_CONFIGURED");
  const config: WebPushConfig = { maxParallelism };
  if (env.WEB_PUSH_VAPID_PUBLIC_KEY !== undefined) {
    const parsed = parsePublicKey(env.WEB_PUSH_VAPID_PUBLIC_KEY);
    if (!parsed.ok) throw webPushError("WEB_PUSH_NOT_CONFIGURED");
    config.publicKey = base64urlEncode(parsed.bytes);
  }
  if (env.WEB_PUSH_VAPID_PRIVATE_KEY !== undefined) {
    const parsed = parsePrivateKey(env.WEB_PUSH_VAPID_PRIVATE_KEY);
    if (!parsed.ok) throw webPushError("WEB_PUSH_NOT_CONFIGURED");
    config.privateKey = base64urlEncode(parsed.bytes);
  }
  if (env.WEB_PUSH_VAPID_SUBJECT !== undefined) {
    if (validateVapidSubject(env.WEB_PUSH_VAPID_SUBJECT) !== null)
      throw webPushError("WEB_PUSH_NOT_CONFIGURED");
    config.subject = env.WEB_PUSH_VAPID_SUBJECT;
  }
  return config;
}

// shared-block:begin
/** Returns true when the caller requests test mode or `WEB_PUSH_TEST_MODE` is `"true"`; the request can enable test mode and cannot disable it. */
export function resolveTestMode(requested: boolean | undefined, env: ComponentEnv): boolean {
  return requested === true || env.WEB_PUSH_TEST_MODE === "true";
}
// shared-block:end

export function requireVapidConfig(config: WebPushConfig) {
  const { publicKey, privateKey, subject } = config;
  if (publicKey === undefined || privateKey === undefined || subject === undefined)
    throw webPushError("WEB_PUSH_NOT_CONFIGURED");
  return { publicKey, privateKey, subject };
}
