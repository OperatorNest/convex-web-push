import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { CLEANUP_BUDGET } from "./limits.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 7 * DAY_MS;
/** Longer than the 4-week maximum TTL, so unfinished rows are only dropped once truly stuck. */
export const STUCK_MS = 35 * DAY_MS;

type DeliveryStatus = Doc<"deliveries">["status"];
type NotificationStatus = Doc<"notifications">["status"];

async function purge(ctx: MutationCtx, now: number) {
  const retained = now - RETENTION_MS;
  const stuck = now - STUCK_MS;
  let remaining = CLEANUP_BUDGET;
  let exhausted = false;
  const steps: ((limit: number) => Promise<number>)[] = [];

  const deliveries = (status: DeliveryStatus, cutoff: number) =>
    steps.push(async (limit) => {
      const rows = await ctx.db
        .query("deliveries")
        .withIndex("by_status_createdAt", (q) => q.eq("status", status).lt("createdAt", cutoff))
        .take(limit);
      for (const row of rows) await ctx.db.delete("deliveries", row._id);
      return rows.length;
    });
  const notifications = (status: NotificationStatus, cutoff: number) =>
    steps.push(async (limit) => {
      const rows = await ctx.db
        .query("notifications")
        .withIndex("by_status_createdAt", (q) => q.eq("status", status).lt("createdAt", cutoff))
        .take(limit);
      for (const row of rows) await ctx.db.delete("notifications", row._id);
      return rows.length;
    });

  for (const status of ["sent", "failed", "gone"] as const) deliveries(status, retained);
  for (const status of ["queued", "sending", "retry"] as const) deliveries(status, stuck);
  for (const status of ["delivered", "failed"] as const) notifications(status, retained);
  for (const status of ["queued", "partial"] as const) notifications(status, stuck);
  steps.push(async (limit) => {
    const rows = await ctx.db
      .query("batches")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "done").lt("createdAt", retained))
      .take(limit);
    for (const row of rows) await ctx.db.delete("batches", row._id);
    return rows.length;
  });
  steps.push(async (limit) => {
    const rows = await ctx.db
      .query("subscriptions")
      .withIndex("by_status_updatedAt", (q) => q.eq("status", "gone").lt("updatedAt", retained))
      .take(limit);
    for (const row of rows) await ctx.db.delete("subscriptions", row._id);
    return rows.length;
  });

  for (const step of steps) {
    if (remaining === 0) {
      exhausted = true;
      break;
    }
    // Sequential on purpose: the combined delete count per transaction stays under the budget.
    const deleted = await step(remaining);
    if (deleted === remaining) exhausted = true;
    remaining -= deleted;
  }
  return { deleted: CLEANUP_BUDGET - remaining, more: exhausted };
}

export const run = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), more: v.boolean() }),
  handler: async (ctx, args) => {
    const result = await purge(ctx, args.now ?? Date.now());
    if (result.more) await ctx.scheduler.runAfter(0, internal.cleanup.run, {});
    return result;
  },
});
