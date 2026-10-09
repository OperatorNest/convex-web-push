import workpool from "@convex-dev/workpool/convex.config.js";
import { defineComponent } from "convex/server";
import { v } from "convex/values";

const component = defineComponent("webPush", {
  env: {
    VAPID_PUBLIC_KEY: v.optional(v.string()),
    VAPID_PRIVATE_KEY: v.optional(v.string()),
    VAPID_SUBJECT: v.optional(v.string()),
    WEB_PUSH_TEST_MODE: v.optional(v.string()),
    WEB_PUSH_MAX_PARALLELISM: v.optional(v.string()),
  },
});

component.use(workpool);

export default component;
