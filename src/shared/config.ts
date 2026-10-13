import { webPushError } from "./errors.js";
import { base64urlEncode } from "./base64url.js";
import { parsePrivateKey, parsePublicKey, validateVapidSubject } from "./vapid.js";

export const DEFAULT_MAX_PARALLELISM = 10;

/** Component environment values remain strings until configuration validation. */
export type WebPushEnv = {
  readonly WEB_PUSH_VAPID_PUBLIC_KEY?: string;
  readonly WEB_PUSH_VAPID_PRIVATE_KEY?: string;
  readonly WEB_PUSH_VAPID_SUBJECT?: string;
  readonly WEB_PUSH_TEST_MODE?: string;
  readonly WEB_PUSH_MAX_PARALLELISM?: string;
};

/** Parsed configuration carries optional VAPID credentials, a test-mode decision and bounded parallelism. */
export type WebPushConfig = {
  publicKey?: string;
  privateKey?: string;
  subject?: string;
  testMode?: boolean;
  maxParallelism: number;
};

export function readConfig(env: WebPushEnv): WebPushConfig {
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
  if (env.WEB_PUSH_TEST_MODE !== undefined) config.testMode = env.WEB_PUSH_TEST_MODE === "true";
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

export function isTestMode(
  requested: boolean | undefined,
  configured: boolean | undefined,
): boolean {
  if (requested !== undefined && typeof requested !== "boolean")
    throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  if (requested === undefined && configured === undefined)
    throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  return requested === true || configured === true;
}

export function requireVapidConfig(config: WebPushConfig) {
  const { publicKey, privateKey, subject } = config;
  if (publicKey === undefined || privateKey === undefined || subject === undefined)
    throw webPushError("WEB_PUSH_NOT_CONFIGURED");
  return { publicKey, privateKey, subject };
}
