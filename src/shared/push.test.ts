import { expect, test } from "vitest";
import {
  checkPushEndpoint,
  clampTtl,
  classifyService,
  isValidTopic,
  MAX_TTL_SECONDS,
} from "./push.js";

test("accepts endpoints on the known push services", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ]) {
    expect(checkPushEndpoint(endpoint).ok).toBe(true);
  }
});

test("rejects everything that could turn the sender into an SSRF relay", () => {
  for (const endpoint of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://evil.example.com/push",
    "https://fcm.googleapis.com.evil.example/push",
    "https://evilfcm.googleapis.com/push",
    "https://push.services.mozilla.com/push",
    "https://127.0.0.1/push",
    "https://[::1]/push",
    "https://localhost/push",
    "https://user:pass@fcm.googleapis.com/push",
    "https://fcm.googleapis.com:8443/push",
    "not a url",
  ]) {
    expect(checkPushEndpoint(endpoint).ok, endpoint).toBe(false);
  }
});

test("allowedPushHosts extends the list but never allows IP literals", () => {
  expect(checkPushEndpoint("https://push.example.test/x").ok).toBe(false);
  expect(checkPushEndpoint("https://push.example.test/x", ["push.example.test"]).ok).toBe(true);
  expect(checkPushEndpoint("https://a.push.example.test/x", ["*.push.example.test"]).ok).toBe(true);
  expect(checkPushEndpoint("https://push.example.test/x", ["*.push.example.test"]).ok).toBe(false);
  expect(checkPushEndpoint("https://10.0.0.1/x", ["10.0.0.1"]).ok).toBe(false);
  expect(checkPushEndpoint("https://localhost/x", ["localhost"]).ok).toBe(false);
});

test("classifies services by host", () => {
  expect(classifyService("fcm.googleapis.com")).toBe("fcm");
  expect(classifyService("updates.push.services.mozilla.com")).toBe("mozilla");
  expect(classifyService("web.push.apple.com")).toBe("apple");
  expect(classifyService("x.notify.windows.com")).toBe("wns");
  expect(classifyService("push.example.test")).toBe("other");
});

test("clamps TTL and validates topics", () => {
  expect(clampTtl(undefined)).toBe(86_400);
  expect(clampTtl(-5)).toBe(0);
  expect(clampTtl(10.9)).toBe(10);
  expect(clampTtl(99_999_999)).toBe(MAX_TTL_SECONDS);
  expect(isValidTopic("unread-count_1")).toBe(true);
  expect(isValidTopic("")).toBe(false);
  expect(isValidTopic("a".repeat(33))).toBe(false);
  expect(isValidTopic("bad topic")).toBe(false);
});
