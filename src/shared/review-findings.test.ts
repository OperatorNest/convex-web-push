import { expect, test } from "vitest";
import { base64urlEncode } from "./base64url.js";
import { validateHosts } from "./bounds.js";
import { checkPushEndpoint } from "./push.js";
import { generateVapidKeys, importVapidPrivateKey, readVapidConfig } from "./vapid.js";

test.each([1, 31])("VAPID rejects a %s-byte private scalar", async (size) => {
  const keys = await generateVapidKeys();
  const privateKey = base64urlEncode(new Uint8Array(size).fill(1));
  expect(
    readVapidConfig({
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: privateKey,
      VAPID_SUBJECT: "mailto:ops@example.com",
    }).ok,
  ).toBe(false);
  await expect(importVapidPrivateKey(keys.publicKey, privateKey)).rejects.toMatchObject({
    data: { code: "WEB_PUSH_INVALID_VAPID_KEY" },
  });
});

test("endpoint admission rejects a trailing-dot hostname even with a wildcard", () => {
  expect(checkPushEndpoint("https://evil.example./push", ["*."]).ok).toBe(false);
  expect(checkPushEndpoint("https://push.example.com./push", ["push.example.com."]).ok).toBe(false);
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
