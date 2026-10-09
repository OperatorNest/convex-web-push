import { vNotificationResult } from "@operatornest/convex-web-push";
import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";

/** Called by the component once every delivery of a notification has finished. */
export const onNotificationComplete = internalMutation({
  args: vNotificationResult,
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
