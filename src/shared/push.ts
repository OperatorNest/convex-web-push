import type { PushService } from "./validators.js";

const DEFAULT_PUSH_HOSTS = [
  "fcm.googleapis.com",
  "*.push.services.mozilla.com",
  "*.push.apple.com",
  "*.notify.windows.com",
] as const;

/** Four weeks: the smallest maximum TTL among the major push services. */
export const MAX_TTL_SECONDS = 2_419_200;
const DEFAULT_TTL_SECONDS = 86_400;

export function isValidTopic(topic: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(topic);
}

export function clampTtl(ttl: number | undefined): number {
  if (ttl === undefined || !Number.isFinite(ttl)) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(Math.floor(ttl), 0), MAX_TTL_SECONDS);
}

export function classifyService(hostname: string): PushService {
  const host = hostname.toLowerCase();
  if (host === "fcm.googleapis.com") return "fcm";
  if (host.endsWith(".push.services.mozilla.com")) return "mozilla";
  if (host.endsWith(".push.apple.com")) return "apple";
  if (host.endsWith(".notify.windows.com")) return "wns";
  return "other";
}

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (p.startsWith("*.")) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
  return host === p;
}

function isIpLiteral(host: string): boolean {
  return host.includes(":") || host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

export type EndpointCheck =
  | { ok: true; url: URL; service: PushService }
  | { ok: false; reason: string };

/**
 * SSRF guard. Subscription endpoints come from untrusted browsers, so only https URLs on known push
 * services (plus the caller's `extraHosts`) are accepted, never IP literals or localhost.
 */
export function checkPushEndpoint(
  endpoint: string,
  extraHosts: readonly string[] = [],
): EndpointCheck {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: "Endpoint is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "Endpoint must use https" };
  if (url.username || url.password)
    return { ok: false, reason: "Endpoint must not contain credentials" };
  if (url.port) return { ok: false, reason: "Endpoint must use the default https port" };
  const host = url.hostname.toLowerCase();
  if (isIpLiteral(host) || host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "Endpoint host is not allowed" };
  }
  const allowed = [...DEFAULT_PUSH_HOSTS, ...extraHosts].some((pattern) =>
    hostMatches(host, pattern),
  );
  if (!allowed)
    return { ok: false, reason: `Endpoint host ${host} is not an allowed push service` };
  return { ok: true, url, service: classifyService(host) };
}
