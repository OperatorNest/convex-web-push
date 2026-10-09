import type { SendOutcome } from "./validators.js";

const MAX_ATTEMPTS = 5;

/** Longest push service response or error text kept on a delivery row. */
export const MAX_ERROR_DETAIL_CHARS = 200;

/** Parses `Retry-After` (delta-seconds or HTTP-date) into milliseconds, or undefined. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return undefined;
    ms = date - now;
  }
  return Math.max(ms, 0);
}

/** Maps a push service HTTP status to retry semantics (RFC 8030 and push service behavior). */
export function classifyPushStatus(
  status: number,
  retryAfterHeader: string | null | undefined,
  now: number,
): SendOutcome {
  if (status >= 200 && status < 300) return { kind: "sent", statusCode: status };
  const base = { statusCode: status };
  if (status === 404 || status === 410)
    return { ...base, kind: "gone", errorKind: "subscription_gone" };
  const retryAfterMs = parseRetryAfter(retryAfterHeader, now);
  const retryAfter = retryAfterMs === undefined ? {} : { retryAfterMs };
  if (status === 429) {
    return { ...base, ...retryAfter, kind: "retryable", errorKind: "rate_limited" };
  }
  if (status === 408 || status >= 500) {
    return { ...base, ...retryAfter, kind: "retryable", errorKind: "server_error" };
  }
  if (status === 413) return { ...base, kind: "permanent", errorKind: "payload_too_large" };
  if (status === 401 || status === 403)
    return { ...base, kind: "permanent", errorKind: "vapid_rejected" };
  if (status >= 300 && status < 400)
    return { ...base, kind: "permanent", errorKind: "unexpected_redirect" };
  return { ...base, kind: "permanent", errorKind: "bad_request" };
}

export function backoffMs(attempts: number, random: number): number {
  const base = Math.min(2000 * 4 ** (attempts - 1), 5 * 60 * 1000);
  return Math.round(base * (1 + random * 0.25));
}

export type RetryPlan = { retry: true; delayMs: number } | { retry: false; reason: string };

/**
 * Decides whether another attempt is allowed. `attempts` counts finished attempts including the one
 * that just failed. A message is never retried at or after its TTL expiry.
 */
export function planRetry(input: {
  attempts: number;
  now: number;
  createdAt: number;
  ttlSeconds: number;
  retryAfterMs?: number | undefined;
  random?: number;
}): RetryPlan {
  if (input.attempts >= MAX_ATTEMPTS) return { retry: false, reason: "max_attempts" };
  const delayMs = Math.max(input.retryAfterMs ?? 0, backoffMs(input.attempts, input.random ?? 0));
  const expiresAt = input.createdAt + input.ttlSeconds * 1000;
  if (input.now + delayMs >= expiresAt) return { retry: false, reason: "ttl_expired" };
  return { retry: true, delayMs };
}

/** Narrows an untrusted workpool return value to a send outcome. */
export function isSendOutcome(value: unknown): value is SendOutcome {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const { kind } = value;
  return kind === "sent" || kind === "retryable" || kind === "permanent" || kind === "gone";
}
