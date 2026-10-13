import { expect, test, afterEach, vi } from "vitest";
import { base64urlDecode } from "./base64url.js";
import { runCli } from "./cli.js";
import { generateVapidKeys } from "./vapid.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("generate-keys prints the three env lines with real keys", async () => {
  const result = await runCli(["generate-keys", "--subject", "mailto:ops@acme.dev"]);
  expect(result.code).toBe(0);
  const lines = new Map(
    result.stdout
      .split("\n")
      .filter((line) => /^WEB_PUSH_VAPID_[A-Z_]+=/.test(line))
      .map((line) => {
        const [name = "", value = ""] = line.split("=");
        return [name, value] as const;
      }),
  );
  expect(base64urlDecode(lines.get("WEB_PUSH_VAPID_PUBLIC_KEY") ?? "").byteLength).toBe(65);
  expect(base64urlDecode(lines.get("WEB_PUSH_VAPID_PRIVATE_KEY") ?? "").byteLength).toBe(32);
  expect(lines.get("WEB_PUSH_VAPID_SUBJECT")).toBe("mailto:ops@acme.dev");
});

test("defaults the subject to a placeholder", async () => {
  const result = await runCli(["generate-keys"], generateVapidKeys);
  expect(result.stdout).toContain("WEB_PUSH_VAPID_SUBJECT=mailto:you@example.com");
});

test("rejects unknown commands, arguments and bad subjects", async () => {
  expect((await runCli(["nope"])).code).toBe(1);
  expect((await runCli(["generate-keys", "--wat"])).code).toBe(1);
  expect((await runCli(["generate-keys", "--subject", "localhost"])).code).toBe(1);
  expect((await runCli([])).code).toBe(1);
  expect((await runCli(["--help"])).code).toBe(0);
});

test("CLI quotes a contact URI containing shell metacharacters", async () => {
  const subject = "https://example.com/contact?x=1&y=2";
  const result = await runCli(["generate-keys", "--subject", subject]);
  expect(result.stdout).toContain("WEB_PUSH_VAPID_SUBJECT '" + subject + "'");
  expect(result.stdout).toContain("WEB_PUSH_VAPID_PUBLIC_KEY '<value>'");
  expect(result.stdout).toContain("WEB_PUSH_VAPID_PRIVATE_KEY '<value>'");
});
