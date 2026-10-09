// Ready-to-copy classic service worker for @operatornest/convex-web-push.
// Copy this file to your site root (for example public/sw.js). It must be served from your origin.
// It handles the payload produced by WebPush.sendNotification. If you bundle your own service
// worker, use registerPushHandlers from "@operatornest/convex-web-push/sw" instead.

const DEFAULT_TITLE = "Notification";
const DEFAULT_URL = "/";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { body: event.data.text() };
    }
  }
  if (!payload || typeof payload !== "object") payload = {};
  event.waitUntil(
    self.registration.showNotification(payload.title || DEFAULT_TITLE, {
      body: payload.body,
      icon: payload.icon,
      badge: payload.badge,
      image: payload.image,
      tag: payload.tag,
      renotify: payload.tag ? payload.renotify : undefined,
      requireInteraction: payload.requireInteraction,
      silent: payload.silent,
      timestamp: payload.timestamp,
      actions: payload.actions,
      data: { url: payload.url || DEFAULT_URL, extra: payload.data },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const origin = self.location.origin;
  let target = new URL(DEFAULT_URL, origin).href;
  try {
    const url = new URL(
      (event.notification.data && event.notification.data.url) || DEFAULT_URL,
      origin,
    );
    if (url.origin === origin) target = url.href;
  } catch {
    // Keep the default target.
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const exact = windows.find((client) => client.url === target);
      if (exact) return exact.focus();
      if (windows[0]) {
        if (windows[0].navigate) await windows[0].navigate(target);
        return windows[0].focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
