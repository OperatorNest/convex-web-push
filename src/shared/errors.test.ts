import { ConvexError } from "convex/values";
import { expect, test } from "vitest";
import { isWebPushError, webPushError, WEB_PUSH_ERROR_CODES } from "./errors.js";

test("every code is upper snake with the WEB_PUSH_ prefix", () => {
  for (const code of WEB_PUSH_ERROR_CODES) expect(code).toMatch(/^WEB_PUSH_[A-Z]+(_[A-Z]+)*$/);
});

test("the factory builds a ConvexError and only includes retryable when given", () => {
  const plain = webPushError("WEB_PUSH_INVALID_TOPIC", "bad topic");
  expect(plain).toBeInstanceOf(ConvexError);
  expect(plain.data).toEqual({ code: "WEB_PUSH_INVALID_TOPIC", message: "bad topic" });
  const retryable = webPushError("WEB_PUSH_NOT_CONFIGURED", "later", true);
  expect(retryable.data).toEqual({
    code: "WEB_PUSH_NOT_CONFIGURED",
    message: "later",
    retryable: true,
  });
});

test("the guard accepts our errors and rejects everything else", () => {
  expect(isWebPushError(webPushError("WEB_PUSH_INVALID_PAYLOAD", "x"))).toBe(true);
  expect(isWebPushError(new ConvexError({ code: "OTHER", message: "x" }))).toBe(false);
  expect(isWebPushError(new ConvexError("text"))).toBe(false);
  expect(isWebPushError(new Error("WEB_PUSH_INVALID_PAYLOAD"))).toBe(false);
  expect(isWebPushError(null)).toBe(false);
});
