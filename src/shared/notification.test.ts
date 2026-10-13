import { expect, test, afterEach, vi } from "vitest";
import { isWebPushError } from "./errors.js";
import { serializeNotification } from "./notification.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function failure(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

test("a notification that is not JSON-serializable fails with WEB_PUSH_INVALID_ARGUMENT", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const data of [1n, circular]) {
    const error = failure(() => serializeNotification({ title: "x", data }));
    expect(isWebPushError(error)).toBe(true);
    expect(isWebPushError(error) && error.data.code).toBe("WEB_PUSH_INVALID_ARGUMENT");
  }
});

test("an oversized notification fails with WEB_PUSH_PAYLOAD_TOO_LARGE", () => {
  const error = failure(() => serializeNotification({ title: "x", body: "a".repeat(4000) }));
  expect(isWebPushError(error) && error.data.code).toBe("WEB_PUSH_PAYLOAD_TOO_LARGE");
});

test("a normal notification serializes to JSON", () => {
  expect(serializeNotification({ title: "x" })).toBe('{"title":"x"}');
});

test("serialization rejects a toJSON result that is undefined", () => {
  expect(() =>
    serializeNotification({ title: "x", toJSON: () => undefined } as { title: string }),
  ).toThrow();
});
