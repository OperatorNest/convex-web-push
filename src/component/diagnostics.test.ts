import { afterEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { generateVapidKeys } from "../shared/vapid.js";
import { configureVapid, setupTest } from "../test-helpers.js";

afterEach(() => vi.unstubAllEnvs());

test("selfTest passes every operation, including the RFC 8291 vector, in test mode", async () => {
  const t = setupTest();
  const report = await t.action(api.diagnostics.selfTest, {});
  expect(report.ok).toBe(true);
  expect(report.testMode).toBe(true);
  expect(report.checks.map((c) => c.name)).toEqual([
    "sha256 digest",
    "ECDH P-256 key agreement",
    "RFC 8291 Appendix A vector",
    "VAPID ES256 sign and verify",
  ]);
  expect(report.checks.every((c) => c.ok)).toBe(true);
  expect(report.config).toEqual({ configured: false, problem: "VAPID_PUBLIC_KEY is not set" });
});

test("selfTest verifies the configured key pair and never leaks it", async () => {
  const keys = await configureVapid();
  const t = setupTest({ testMode: false });
  const report = await t.action(api.diagnostics.selfTest, {});
  expect(report.ok).toBe(true);
  expect(report.testMode).toBe(false);
  expect(report.config).toEqual({ configured: true });
  expect(report.checks.at(-1)).toEqual({ name: "configured VAPID key pair matches", ok: true });
  expect(JSON.stringify(report)).not.toContain(keys.privateKey);
});

test("selfTest flags a mismatched key pair", async () => {
  const a = await generateVapidKeys();
  const b = await generateVapidKeys();
  vi.stubEnv("VAPID_PUBLIC_KEY", a.publicKey);
  vi.stubEnv("VAPID_PRIVATE_KEY", b.privateKey);
  vi.stubEnv("VAPID_SUBJECT", "mailto:ops@example.com");
  const t = setupTest();
  const report = await t.action(api.diagnostics.selfTest, {});
  expect(report.ok).toBe(false);
  expect(report.config).toEqual({ configured: true });
  expect(report.checks.at(-1)).toMatchObject({ ok: false, error: expect.any(String) });
  expect(JSON.stringify(report)).not.toContain(b.privateKey);
});

test("selfTest reports a bad subject as a configuration problem", async () => {
  const keys = await generateVapidKeys();
  vi.stubEnv("VAPID_PUBLIC_KEY", keys.publicKey);
  vi.stubEnv("VAPID_PRIVATE_KEY", keys.privateKey);
  vi.stubEnv("VAPID_SUBJECT", "https://localhost");
  const t = setupTest();
  const report = await t.action(api.diagnostics.selfTest, {});
  expect(report.config.configured).toBe(false);
  expect(report.config.problem).toContain("reserved");
  expect(JSON.stringify(report)).not.toContain(keys.privateKey);
});
