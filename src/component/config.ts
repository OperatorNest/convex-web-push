import { v } from "convex/values";
import { env, query } from "./_generated/server.js";

export const getPublicKey = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async () => env.VAPID_PUBLIC_KEY ?? null,
});
