import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { generateVapidKeys } from "../shared/vapid.js";
import {
  configureVapid,
  expectWebPushError,
  setupLiveTest,
  setupSimulatedTest,
} from "../test-helpers.js";

const NOT_CONFIGURED_MESSAGE =
  "Component configuration is missing, malformed or changed during a batch.";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test("config get returns the configured public key and null only in unconfigured test mode", async () => {
  const t = setupLiveTest();
  expect(await t.query(api.config.get, { testMode: true })).toEqual({
    applicationServerKey: null,
  });
  await expectWebPushError(t.query(api.config.get, {}), "WEB_PUSH_NOT_CONFIGURED");
  const keys = await configureVapid();
  expect(await t.query(api.config.get, {})).toEqual({ applicationServerKey: keys.publicKey });
});

test("config get without a test-mode decision is live and requires VAPID configuration", async () => {
  const t = setupSimulatedTest();
  vi.stubEnv("WEB_PUSH_TEST_MODE", undefined);
  await expectWebPushError(t.query(api.config.get, {}), "WEB_PUSH_NOT_CONFIGURED");
});

test("config verify passes every cryptographic operation in test mode", async () => {
  const t = setupSimulatedTest();
  const report = await t.action(api.config.verify, {});
  expect(report.ok).toBe(true);
  expect(report.testMode).toBe(true);
  expect(report.checks.map((c) => c.name)).toEqual([
    "sha256 digest",
    "ECDH P-256 key agreement",
    "RFC 8291 Appendix A vector",
    "VAPID ES256 sign and verify",
  ]);
  expect(report.checks.every((c) => c.ok)).toBe(true);
  expect(report.config).toEqual({ configured: false, problem: NOT_CONFIGURED_MESSAGE });
});

test("config verify accepts a matching configured key pair without returning it", async () => {
  const keys = await configureVapid();
  const t = setupLiveTest();
  const report = await t.action(api.config.verify, {});
  expect(report).toMatchObject({ ok: true, testMode: false, config: { configured: true } });
  expect(JSON.stringify(report)).not.toContain(keys.privateKey);
});

test("config verify raises NOT_CONFIGURED for a mismatched key pair without echoing keys", async () => {
  const a = await generateVapidKeys();
  const b = await generateVapidKeys();
  vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", a.publicKey);
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", b.privateKey);
  vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", "mailto:ops@acme.dev");
  const t = setupSimulatedTest();
  const error: unknown = await t.action(api.config.verify, {}).catch((caught: unknown) => caught);
  expect(error).toMatchObject({
    data: { code: "WEB_PUSH_NOT_CONFIGURED", message: NOT_CONFIGURED_MESSAGE },
  });
  expect(JSON.stringify(error)).not.toContain(b.privateKey);
});

test("config verify rejects malformed configuration without returning keys", async () => {
  const keys = await generateVapidKeys();
  vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", keys.publicKey);
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", keys.privateKey);
  vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", "https://localhost");
  const t = setupSimulatedTest();
  const error: unknown = await t.action(api.config.verify, {}).catch((caught: unknown) => caught);
  expect(error).toMatchObject({
    data: { code: "WEB_PUSH_NOT_CONFIGURED", message: NOT_CONFIGURED_MESSAGE },
  });
  expect(JSON.stringify(error)).not.toContain(keys.privateKey);
});

test("config verify reports a failed check with the package error message it raised", async () => {
  const importKey = crypto.subtle.importKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "importKey").mockImplementation((...args: unknown[]) =>
    args[0] === "jwk" && args[3] === false
      ? Promise.reject(new DOMException("unsupported"))
      : Reflect.apply(importKey, crypto.subtle, args),
  );
  const t = setupSimulatedTest();
  const report = await t.action(api.config.verify, {});
  expect(report.ok).toBe(false);
  expect(report.checks.find((c) => c.name === "VAPID ES256 sign and verify")).toEqual({
    name: "VAPID ES256 sign and verify",
    ok: false,
    error: NOT_CONFIGURED_MESSAGE,
  });
});

test("config verify reports a non-package check failure as unsupported WebCrypto", async () => {
  vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new DOMException("unsupported"));
  const t = setupSimulatedTest();
  const report = await t.action(api.config.verify, {});
  expect(report.checks[0]).toEqual({
    name: "sha256 digest",
    ok: false,
    error: "The runtime cannot complete the required WebCrypto operation.",
  });
});
