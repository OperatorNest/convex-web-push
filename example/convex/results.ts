import {
  webPushBatchCompleteArgsValidator,
  webPushNotificationCompleteArgsValidator,
} from "@operatornest/convex-web-push";
import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";

export const onNotificationComplete = internalMutation({
  args: webPushNotificationCompleteArgsValidator,
  returns: v.null(),
  handler: async (ctx, { counts, ...rest }) => {
    await ctx.db.insert("notificationResults", {
      ...rest,
      sent: counts.sent,
      failed: counts.failed,
      gone: counts.gone,
    });
    return null;
  },
});

export const onBatchComplete = internalMutation({
  args: webPushBatchCompleteArgsValidator,
  returns: v.null(),
  handler: async (ctx, result) => {
    await ctx.db.insert("batchResults", result);
    return null;
  },
});
