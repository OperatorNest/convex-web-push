import { vNotificationResult } from "@operatornest/convex-web-push";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  /** Written by the `onComplete` callback so the app can see how a send ended. */
  notificationResults: defineTable({
    notificationId: v.string(),
    userId: v.string(),
    status: vNotificationResult.fields.status,
    sent: v.number(),
    failed: v.number(),
    gone: v.number(),
  }).index("by_userId", ["userId"]),
});
