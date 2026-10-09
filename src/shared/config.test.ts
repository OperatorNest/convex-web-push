import { expect, test } from "vitest";
import { DEFAULT_MAX_PARALLELISM, isTestMode, readMaxParallelism } from "./config.js";

test("test mode needs an explicit opt-in from the client option or the env", () => {
  expect(isTestMode(undefined, undefined)).toBe(false);
  expect(isTestMode(false, undefined)).toBe(false);
  expect(isTestMode(false, "false")).toBe(false);
  expect(isTestMode(false, "1")).toBe(false);
  expect(isTestMode(true, undefined)).toBe(true);
  expect(isTestMode(undefined, "true")).toBe(true);
});

test("max parallelism defaults when unset and accepts integers from 1 to 200", () => {
  expect(readMaxParallelism(undefined)).toEqual({ ok: true, value: DEFAULT_MAX_PARALLELISM });
  expect(readMaxParallelism("  ")).toEqual({ ok: true, value: DEFAULT_MAX_PARALLELISM });
  expect(readMaxParallelism("1")).toEqual({ ok: true, value: 1 });
  expect(readMaxParallelism("200")).toEqual({ ok: true, value: 200 });
});

test("max parallelism rejects everything else with a clear problem", () => {
  for (const raw of ["0", "201", "-3", "2.5", "many"]) {
    expect(readMaxParallelism(raw), raw).toEqual({
      ok: false,
      problem: "WEB_PUSH_MAX_PARALLELISM must be an integer from 1 to 200",
    });
  }
});
