import { expect, test } from "vitest";
import {
  boundedString,
  boundedUtf8String,
  readBoundedText,
  validateHosts,
  validateIdempotencyKey,
} from "./bounds.js";

const invalidArgument = expect.objectContaining({
  data: expect.objectContaining({ code: "WEB_PUSH_INVALID_ARGUMENT" }),
});

test.each([
  "*.",
  "*.com",
  "*.example..com",
  "example.com.",
  ".example.com",
  "https://example.com",
  "example.com/path",
  "example.com:443",
  "*example.com",
  "foo.*.com",
  "-foo.example.com",
  "foo_.example.com",
  " example.com",
])("allowed host rejects malformed pattern %j", (host) => {
  expect(() => validateHosts([host])).toThrowError(invalidArgument);
});

test("allowed hosts accept exact names and wildcard DNS suffixes", () => {
  expect(() =>
    validateHosts(["push.example.com", "*.example.com", "PUSH.EXAMPLE.COM"]),
  ).not.toThrow();
});

test("boundedUtf8String counts UTF-8 bytes", () => {
  expect(() => boundedUtf8String("é".repeat(128), 256)).not.toThrow();
  for (const value of ["", "é".repeat(128) + "a", "\ud800"])
    expect(() => boundedUtf8String(value, 256)).toThrowError(invalidArgument);
});

test("boundedString counts UTF-16 code units", () => {
  expect(boundedString("é".repeat(4096), 4096)).toBe("é".repeat(4096));
  for (const value of ["", "a".repeat(4097), "\udc00"])
    expect(() => boundedString(value, 4096)).toThrowError(invalidArgument);
});

test("validateIdempotencyKey accepts 1 to 128 characters from A-Za-z0-9_-", () => {
  expect(validateIdempotencyKey("Order_1-a".padEnd(128, "z"))).toHaveLength(128);
  for (const key of ["", "a".repeat(129), "order 1", "order.1", "é"])
    expect(() => validateIdempotencyKey(key)).toThrowError(invalidArgument);
});

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test("readBoundedText decodes a body split inside a UTF-8 sequence", async () => {
  const bytes = new TextEncoder().encode("gone é");
  const response = new Response(streamOf([bytes.slice(0, 6), bytes.slice(6)]));
  await expect(readBoundedText(response, bytes.byteLength)).resolves.toBe("gone é");
});

test("readBoundedText returns undefined past maxBytes, for malformed UTF-8 and reads a missing body as empty", async () => {
  await expect(
    readBoundedText(new Response("abcd", { headers: { "content-length": "4" } }), 3),
  ).resolves.toBeUndefined();
  await expect(
    readBoundedText(new Response(streamOf([new Uint8Array(2), new Uint8Array(2)])), 3),
  ).resolves.toBeUndefined();
  await expect(readBoundedText(new Response(new Uint8Array([0xff])), 16)).resolves.toBeUndefined();
  await expect(readBoundedText(new Response(null, { status: 204 }), 16)).resolves.toBe("");
});
