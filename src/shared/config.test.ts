import { expect, test } from "vitest";
import { DEFAULT_MAX_PARALLELISM, isTestMode, readConfig, requireVapidConfig } from "./config.js";
import { generateVapidKeys } from "./vapid.js";
import { base64urlEncode } from "./base64url.js";

test("test mode requires a decision and cannot override an enabled environment", () => {
  expect(() => isTestMode(undefined, undefined)).toThrow();
  expect(isTestMode(false, undefined)).toBe(false);
  expect(isTestMode(false, false)).toBe(false);
  expect(isTestMode(true, undefined)).toBe(true);
  expect(isTestMode(undefined, true)).toBe(true);
  expect(isTestMode(false, true)).toBe(true);
});

test("parallelism defaults only when absent and accepts the configured bounds", () => {
  expect(readConfig({}).maxParallelism).toBe(DEFAULT_MAX_PARALLELISM);
  expect(readConfig({ WEB_PUSH_MAX_PARALLELISM: "1" }).maxParallelism).toBe(1);
  expect(readConfig({ WEB_PUSH_MAX_PARALLELISM: "200" }).maxParallelism).toBe(200);
});

test.each(["", "  ", "0", "201", "-3", "2.5", "many", "1e2"])(
  "malformed parallelism %j raises NOT_CONFIGURED",
  (raw) => {
    expect(() => readConfig({ WEB_PUSH_MAX_PARALLELISM: raw })).toThrowError(
      expect.objectContaining({
        data: expect.objectContaining({ code: "WEB_PUSH_NOT_CONFIGURED" }),
      }),
    );
  },
);

test.each(["", "1", "TRUE", " false "])("malformed test mode %j raises NOT_CONFIGURED", (raw) => {
  expect(() => readConfig({ WEB_PUSH_TEST_MODE: raw })).toThrow();
});

test("non-test work requires all VAPID values", async () => {
  const keys = await generateVapidKeys();
  expect(() => requireVapidConfig(readConfig({}))).toThrow();
  const env = {
    WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
    WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
    WEB_PUSH_VAPID_SUBJECT: "mailto:ops@example.com",
  };
  expect(requireVapidConfig(readConfig(env))).toEqual({
    ...keys,
    subject: "mailto:ops@example.com",
  });
  for (const field of Object.keys(env)) {
    expect(() => readConfig({ ...env, [field]: "***" })).toThrowError(
      expect.objectContaining({
        data: expect.objectContaining({ code: "WEB_PUSH_NOT_CONFIGURED" }),
      }),
    );
  }
});

test("configuration rejects off-curve public keys and zero private scalars", () => {
  const values = [
    { WEB_PUSH_VAPID_PUBLIC_KEY: base64urlEncode(new Uint8Array([4, ...new Uint8Array(64)])) },
    { WEB_PUSH_VAPID_PRIVATE_KEY: base64urlEncode(new Uint8Array(32)) },
  ];
  for (const env of values) {
    expect(() => readConfig(env)).toThrowError(
      expect.objectContaining({
        data: expect.objectContaining({ code: "WEB_PUSH_NOT_CONFIGURED" }),
      }),
    );
  }
});
