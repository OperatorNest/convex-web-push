const DEFAULTS = { title: "Notification", url: "/" };

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function parsePushPayload(data) {
  if (!data) return {};
  try {
    const parsed = data.json();
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  try {
    return { body: data.text() };
  } catch {
    return {};
  }
}

function resolveClickUrl(data) {
  try {
    const root = new URL("/", self.location.origin);
    const fallback = new URL(DEFAULTS.url, root);
    const safeFallback = fallback.origin === root.origin ? fallback : root;
    const raw = typeof data === "object" && data !== null && "url" in data ? data.url : undefined;
    const url = new URL(typeof raw === "string" ? raw : safeFallback.href, root);
    return url.origin === root.origin ? url.href : safeFallback.href;
  } catch {
    return new URL("/", self.location.origin).href;
  }
}

self.addEventListener("push", (event) => {
  const payload = parsePushPayload(event.data);
  event.waitUntil(
    self.registration.showNotification(payload.title ?? DEFAULTS.title, {
      body: payload.body,
      icon: payload.icon ?? DEFAULTS.icon,
      badge: payload.badge ?? DEFAULTS.badge,
      image: payload.image,
      tag: payload.tag,
      renotify: payload.tag ? payload.renotify : undefined,
      requireInteraction: payload.requireInteraction,
      silent: payload.silent,
      timestamp: payload.timestamp,
      actions: payload.actions,
      data: { url: payload.url ?? DEFAULTS.url, extra: payload.data },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = resolveClickUrl(event.notification.data);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const exact = windows.find((client) => client.url === target);
      if (exact) return exact.focus();
      const firstWindow = windows[0];
      if (firstWindow && firstWindow.navigate) {
        const navigated = await firstWindow.navigate(target).then(
          () => true,
          () => false,
        );
        if (navigated) return firstWindow.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
