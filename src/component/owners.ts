import { v } from "convex/values";
import { sha256Hex } from "../shared/sha256.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

export const purgeResultValidator = v.object({ removed: v.number(), done: v.boolean() });

export function findOwner(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  testMode: boolean,
): Promise<Doc<"subscriptionOwners"> | null> {
  return ctx.db
    .query("subscriptionOwners")
    .withIndex("by_userId_and_testMode", (q) => q.eq("userId", userId).eq("testMode", testMode))
    .unique();
}

/** A purge continuation may delete subscriptions only while its generation is still current or superseded. */
export function generationIsCurrent(
  owner: Doc<"subscriptionOwners"> | null,
  generation: number,
): boolean {
  return owner !== null && owner.generation >= generation;
}

export async function findByEndpoint(
  ctx: QueryCtx | MutationCtx,
  endpoint: string,
  testMode: boolean,
): Promise<Doc<"subscriptions"> | null> {
  const row = await ctx.db
    .query("subscriptions")
    .withIndex("by_endpointHash_and_testMode", (q) =>
      q.eq("endpointHash", sha256Hex(endpoint)).eq("testMode", testMode),
    )
    .first();
  return row?.endpoint === endpoint ? row : null;
}
