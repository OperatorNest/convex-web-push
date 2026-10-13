import { ConvexError } from "convex/values";
import { expect, test } from "vitest";
import { isWebPushError, webPushError, WEB_PUSH_ERROR_CODES } from "./errors.js";

test("every code is upper snake with the WEB_PUSH_ prefix", () => {
  for (const code of WEB_PUSH_ERROR_CODES) expect(code).toMatch(/^WEB_PUSH_[A-Z]+(_[A-Z]+)*$/);
});

test("the factory uses a fixed message and an optional HTTP status", () => {
  const plain = webPushError("WEB_PUSH_INVALID_TOPIC");
  expect(plain).toBeInstanceOf(ConvexError);
  expect(plain.data).toEqual({
    code: "WEB_PUSH_INVALID_TOPIC",
    message: "The topic must contain 1 to 32 characters from A-Z, a-z, 0-9, _ or -.",
  });
  expect(webPushError("WEB_PUSH_SERVICE_FAILED", 503).data.providerStatus).toBe(503);
});

test("the guard accepts our errors and rejects everything else", () => {
  expect(isWebPushError(webPushError("WEB_PUSH_INVALID_PAYLOAD"))).toBe(true);
  expect(isWebPushError(new ConvexError({ code: "OTHER", message: "x" }))).toBe(false);
  expect(isWebPushError(new ConvexError("text"))).toBe(false);
  expect(isWebPushError(new Error("WEB_PUSH_INVALID_PAYLOAD"))).toBe(false);
  expect(isWebPushError(null)).toBe(false);
});
