/**
 * Service worker handlers for the payload shape produced by `WebPush.sendNotification`.
 * Written against minimal structural types so it needs neither the DOM nor WebWorker libs.
 */

export type PushPayload = {
  title?: string;
  body?: string;
  icon?: string;
  badge?: string;
  image?: string;
  url?: string;
  tag?: string;
  renotify?: boolean;
  requireInteraction?: boolean;
  silent?: boolean;
  timestamp?: number;
  actions?: { action: string; title: string; icon?: string }[];
  data?: unknown;
};

export type PushHandlerOptions = {
  /** Title when the push carries no title. Default "Notification". */
  defaultTitle?: string;
  defaultIcon?: string;
  defaultBadge?: string;
  /** Where a click goes when the payload has no `url`. Default "/". */
  defaultUrl?: string;
};

type PushEventLike = {
  data: { json(): unknown; text(): string } | null;
  waitUntil(promise: Promise<unknown>): void;
};

type ClientLike = {
  url: string;
  focus(): Promise<unknown>;
  navigate?(url: string): Promise<unknown>;
};

type ClickEventLike = {
  notification: { close(): void; data?: unknown };
  waitUntil(promise: Promise<unknown>): void;
};

type Scope = {
  addEventListener(type: string, listener: (event: never) => void): void;
  registration: { showNotification(title: string, options?: object): Promise<void> };
  clients: {
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<ClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  location: { origin: string };
};

export function parsePushPayload(data: PushEventLike["data"]): PushPayload {
  if (!data) return {};
  try {
    const parsed: unknown = data.json();
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Not JSON: fall through to plain text.
  }
  try {
    return { body: data.text() };
  } catch {
    return {};
  }
}

export function buildNotification(payload: PushPayload, options: PushHandlerOptions = {}) {
  return {
    title: payload.title ?? options.defaultTitle ?? "Notification",
    options: {
      body: payload.body,
      icon: payload.icon ?? options.defaultIcon,
      badge: payload.badge ?? options.defaultBadge,
      image: payload.image,
      tag: payload.tag,
      renotify: payload.tag ? payload.renotify : undefined,
      requireInteraction: payload.requireInteraction,
      silent: payload.silent,
      timestamp: payload.timestamp,
      actions: payload.actions,
      data: { url: payload.url ?? options.defaultUrl ?? "/", extra: payload.data },
    },
  };
}

/** Resolves the click target, falling back to `fallback` for cross-origin or invalid URLs. */
export function resolveClickUrl(data: unknown, origin: string, fallback = "/"): string {
  const raw: unknown =
    typeof data === "object" && data !== null && "url" in data ? data.url : undefined;
  try {
    const url = new URL(typeof raw === "string" ? raw : fallback, origin);
    return url.origin === origin ? url.href : new URL(fallback, origin).href;
  } catch {
    return new URL("/", origin).href;
  }
}

/** Registers `push` and `notificationclick` handlers. Call it at the top level of your worker. */
export function registerPushHandlers(self: object, options: PushHandlerOptions = {}): void {
  // The real ServiceWorkerGlobalScope satisfies this structural subset.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the real ServiceWorkerGlobalScope satisfies this structural subset
  const scope = self as Scope;
  scope.addEventListener("push", (event: PushEventLike) => {
    const { title, options: notification } = buildNotification(
      parsePushPayload(event.data),
      options,
    );
    event.waitUntil(scope.registration.showNotification(title, notification));
  });

  scope.addEventListener("notificationclick", (event: ClickEventLike) => {
    event.notification.close();
    const target = resolveClickUrl(
      event.notification.data,
      scope.location.origin,
      options.defaultUrl,
    );
    event.waitUntil(
      (async () => {
        const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
        const exact = windows.find((client) => client.url === target);
        if (exact) return exact.focus();
        const any = windows[0];
        if (any) {
          await any.navigate?.(target);
          return any.focus();
        }
        return scope.clients.openWindow(target);
      })(),
    );
  });
}
