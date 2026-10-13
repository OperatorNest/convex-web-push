import { expect, test } from "vitest";
import { validateHosts } from "./bounds.js";

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
  expect(() => validateHosts([host])).toThrowError(
    expect.objectContaining({
      data: expect.objectContaining({ code: "WEB_PUSH_INVALID_ARGUMENT" }),
    }),
  );
});

test("allowed hosts accept exact names and wildcard DNS suffixes", () => {
  expect(() =>
    validateHosts(["push.example.com", "*.example.com", "PUSH.EXAMPLE.COM"]),
  ).not.toThrow();
});
