import { Workpool } from "@convex-dev/workpool";
import { readConfig } from "../shared/config.js";
import { components } from "./_generated/api.js";
import { env } from "./_generated/server.js";

export function deliveryPool(): Workpool {
  const parallelism = readConfig(env);
  return new Workpool(components.workpool, {
    maxParallelism: parallelism.maxParallelism,
    retryActionsByDefault: false,
  });
}
