import {
  vWebPushBatchCompleteArgs,
  vWebPushNotificationCompleteArgs,
} from "@operatornest/convex-web-push";
import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";

export const onNotificationComplete = internalMutation({
  args: vWebPushNotificationCompleteArgs,
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
  args: vWebPushBatchCompleteArgs,
  returns: v.null(),
  handler: async (ctx, result) => {
    await ctx.db.insert("batchResults", result);
    return null;
  },
});
