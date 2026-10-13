export const DEFAULT_MAX_PARALLELISM = 10;

const MAX_PARALLELISM = 200;

export function isTestMode(requested: boolean | undefined, envValue: string | undefined): boolean {
  return requested === true || envValue === "true";
}

export type MaxParallelism = { ok: true; value: number } | { ok: false; problem: string };

export function readMaxParallelism(raw: string | undefined): MaxParallelism {
  if (raw === undefined || raw.trim() === "") return { ok: true, value: DEFAULT_MAX_PARALLELISM };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PARALLELISM) {
    return {
      ok: false,
      problem: `WEB_PUSH_MAX_PARALLELISM must be an integer from 1 to ${MAX_PARALLELISM}`,
    };
  }
  return { ok: true, value };
}
