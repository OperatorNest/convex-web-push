import { defineApp } from "convex/server";
import { v } from "convex/values";
import webPush from "@operatornest/convex-web-push/convex.config.js";

const app = defineApp({
  env: {
    WEB_PUSH_VAPID_PUBLIC_KEY: v.optional(v.string()),
    WEB_PUSH_VAPID_PRIVATE_KEY: v.optional(v.string()),
    WEB_PUSH_VAPID_SUBJECT: v.optional(v.string()),
    WEB_PUSH_TEST_MODE: v.optional(v.string()),
    WEB_PUSH_MAX_PARALLELISM: v.optional(v.string()),
  },
});

app.use(webPush, {
  env: {
    WEB_PUSH_VAPID_PUBLIC_KEY: app.env.WEB_PUSH_VAPID_PUBLIC_KEY,
    WEB_PUSH_VAPID_PRIVATE_KEY: app.env.WEB_PUSH_VAPID_PRIVATE_KEY,
    WEB_PUSH_VAPID_SUBJECT: app.env.WEB_PUSH_VAPID_SUBJECT,
    WEB_PUSH_TEST_MODE: app.env.WEB_PUSH_TEST_MODE,
    WEB_PUSH_MAX_PARALLELISM: app.env.WEB_PUSH_MAX_PARALLELISM,
  },
});

export default app;
