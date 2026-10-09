import { Workpool } from "@convex-dev/workpool";
import { DEFAULT_MAX_PARALLELISM, readMaxParallelism } from "../shared/config.js";
import { components } from "./_generated/api.js";
import { env } from "./_generated/server.js";

/**
 * Workpool's `maxParallelism` is global to the pool, so it comes from one place only: the
 * component env `WEB_PUSH_MAX_PARALLELISM`. Retries are planned by `deliveries.onComplete`, so the
 * pool itself never retries.
 */
export function deliveryPool(): Workpool {
  const parallelism = readMaxParallelism(env.WEB_PUSH_MAX_PARALLELISM);
  return new Workpool(components.workpool, {
    maxParallelism: parallelism.ok ? parallelism.value : DEFAULT_MAX_PARALLELISM,
    retryActionsByDefault: false,
  });
}
