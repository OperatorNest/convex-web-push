import { ConvexError } from "convex/values";
import { expect, test, afterEach, vi } from "vitest";
import { MAX_ENCODED_PAYLOAD_LENGTH, MAX_PLAINTEXT_BYTES } from "./encrypt.js";
import { isWebPushError, webPushError, WEB_PUSH_ERROR_CODES } from "./errors.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("every code is upper snake with the WEB_PUSH_ prefix", () => {
  for (const code of WEB_PUSH_ERROR_CODES) expect(code).toMatch(/^WEB_PUSH_[A-Z]+(_[A-Z]+)*$/);
});

test("the payload size message states both payload limits", () => {
  const { message } = webPushError("WEB_PUSH_PAYLOAD_TOO_LARGE").data;
  expect(message).toContain(`${MAX_PLAINTEXT_BYTES} bytes`);
  expect(message).toContain(`${MAX_ENCODED_PAYLOAD_LENGTH} UTF-16 code units`);
});

test("the factory uses a fixed message and an optional HTTP status", () => {
  const plain = webPushError("WEB_PUSH_INVALID_ARGUMENT");
  expect(plain).toBeInstanceOf(ConvexError);
  expect(plain.data).toEqual({
    code: "WEB_PUSH_INVALID_ARGUMENT",
    message: "An argument is missing, malformed or out of bounds.",
  });
  expect(
    webPushError("WEB_PUSH_PROVIDER_ERROR", { providerStatus: 503, retryable: true }).data
      .providerStatus,
  ).toBe(503);
});

test("the guard accepts our errors and rejects everything else", () => {
  expect(isWebPushError(webPushError("WEB_PUSH_INVALID_ARGUMENT"))).toBe(true);
  expect(isWebPushError(new ConvexError({ code: "OTHER", message: "x" }))).toBe(false);
  expect(isWebPushError(new ConvexError("text"))).toBe(false);
  expect(isWebPushError(new Error("WEB_PUSH_INVALID_ARGUMENT"))).toBe(false);
  expect(isWebPushError(null)).toBe(false);
});

test("the error guard rejects malformed messages and provider statuses", () => {
  expect(isWebPushError(new ConvexError({ code: "WEB_PUSH_INVALID_ARGUMENT", message: 3 }))).toBe(
    false,
  );
  expect(
    isWebPushError(
      new ConvexError({ code: "WEB_PUSH_INVALID_ARGUMENT", message: "x", providerStatus: "500" }),
    ),
  ).toBe(false);
});

test("the error guard requires the fixed message and limits retryability to provider or network errors", () => {
  const argument = webPushError("WEB_PUSH_INVALID_ARGUMENT");
  expect(isWebPushError(new ConvexError({ ...argument.data, message: "Untrusted failure" }))).toBe(
    false,
  );
  expect(isWebPushError(new ConvexError({ ...argument.data, retryable: true }))).toBe(false);
  const provider = webPushError("WEB_PUSH_PROVIDER_ERROR", {
    retryable: true,
    providerStatus: 503,
    providerCode: "x".repeat(63) + "😀",
  });
  expect(provider.data.providerCode).toBe("x".repeat(63));
  expect(isWebPushError(provider)).toBe(true);
});
