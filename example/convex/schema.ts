import {
  vWebPushBatchCompleteArgs,
  vWebPushNotificationCompleteArgs,
} from "@operatornest/convex-web-push";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  batchResults: defineTable(vWebPushBatchCompleteArgs).index("by_batchId", ["batchId"]),
  notificationResults: defineTable({
    notificationId: v.string(),
    userId: v.string(),
    testMode: v.boolean(),
    status: vWebPushNotificationCompleteArgs.fields.status,
    sent: v.number(),
    failed: v.number(),
    gone: v.number(),
  }).index("by_userId_and_testMode", ["userId", "testMode"]),
});
