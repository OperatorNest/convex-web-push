import { expect, test } from "vitest";
import { backoffMs, classifyPushStatus, parseRetryAfter, planRetry } from "./classify.js";

const now = Date.UTC(2026, 9, 4);
const MAX_ATTEMPTS = 5;

test("classifies HTTP statuses", () => {
  expect(classifyPushStatus(201, null, now).kind).toBe("sent");
  expect(classifyPushStatus(202, null, now).kind).toBe("sent");
  expect(classifyPushStatus(404, null, now)).toMatchObject({
    kind: "gone",
    errorKind: "subscription_gone",
  });
  expect(classifyPushStatus(410, null, now).kind).toBe("gone");
  expect(classifyPushStatus(413, null, now)).toMatchObject({
    kind: "permanent",
    errorKind: "payload_too_large",
  });
  expect(classifyPushStatus(400, null, now).kind).toBe("permanent");
  expect(classifyPushStatus(401, null, now)).toMatchObject({
    kind: "permanent",
    errorKind: "vapid_rejected",
  });
  expect(classifyPushStatus(403, null, now)).toMatchObject({
    kind: "permanent",
    errorKind: "vapid_rejected",
  });
  expect(classifyPushStatus(302, null, now).errorKind).toBe("unexpected_redirect");
  for (const status of [408, 500, 502, 503, 504]) {
    expect(classifyPushStatus(status, null, now).kind).toBe("retryable");
  }
  expect(classifyPushStatus(429, "30", now)).toMatchObject({
    kind: "retryable",
    errorKind: "rate_limited",
    retryAfterMs: 30_000,
  });
});

test("parses Retry-After seconds and HTTP dates", () => {
  expect(parseRetryAfter("120", now)).toBe(120_000);
  expect(parseRetryAfter(new Date(now + 5000).toUTCString(), now)).toBe(5000);
  expect(parseRetryAfter(new Date(now - 5000).toUTCString(), now)).toBe(0);
  expect(parseRetryAfter("garbage", now)).toBeUndefined();
  expect(parseRetryAfter(null, now)).toBeUndefined();
  expect(parseRetryAfter("999999999", now)).toBe(999_999_999_000);
});

test("a long Retry-After is kept so the TTL planner decides", () => {
  expect(classifyPushStatus(429, "172800", now).retryAfterMs).toBe(172_800_000);
});

test("backoff grows and jitter stays within 25 percent", () => {
  expect(backoffMs(1, 0)).toBe(2000);
  expect(backoffMs(2, 0)).toBe(8000);
  expect(backoffMs(1, 1)).toBe(2500);
  expect(backoffMs(10, 0)).toBe(300_000);
});

test("planRetry honours Retry-After, max attempts and the TTL horizon", () => {
  const base = { now, createdAt: now, ttlSeconds: 3600 };
  expect(planRetry({ ...base, attempts: 1 })).toEqual({ retry: true, delayMs: 2000 });
  expect(planRetry({ ...base, attempts: 1, retryAfterMs: 60_000 })).toEqual({
    retry: true,
    delayMs: 60_000,
  });
  expect(planRetry({ ...base, attempts: MAX_ATTEMPTS })).toEqual({
    retry: false,
    reason: "max_attempts",
  });
  expect(planRetry({ ...base, attempts: 1, ttlSeconds: 0 })).toEqual({
    retry: false,
    reason: "ttl_expired",
  });
  expect(planRetry({ ...base, attempts: 1, ttlSeconds: 2 })).toEqual({
    retry: false,
    reason: "ttl_expired",
  });
  expect(planRetry({ ...base, attempts: 1, retryAfterMs: 7_200_000 })).toEqual({
    retry: false,
    reason: "ttl_expired",
  });
});
