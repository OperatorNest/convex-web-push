import { webPushError } from "../shared/errors.js";

/** A push payload supplies notification display fields and a same-origin click destination. */
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

/** Push handler options supply display and click defaults when the payload omits them. */
export type PushHandlerOptions = {
  defaultTitle?: string;
  defaultIcon?: string;
  defaultBadge?: string;

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
  addEventListener(type: string, listener: (event: unknown) => void): void;
  registration: { showNotification(title: string, options?: object): Promise<void> };
  clients: {
    matchAll(options: {
      type: "window";
      includeUncontrolled: boolean;
    }): Promise<readonly ClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  location: { origin: string };
};

export function parsePushPayload(data: PushEventLike["data"]): PushPayload {
  if (!data) return {};
  try {
    const parsed: unknown = data.json();
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
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

export function resolveClickUrl(data: unknown, origin: string, fallback = "/"): string {
  try {
    const root = new URL("/", origin);
    const defaultUrl = new URL(fallback, root);
    const safeFallback = defaultUrl.origin === root.origin ? defaultUrl : root;
    const raw: unknown =
      typeof data === "object" && data !== null && "url" in data ? data.url : undefined;
    const url = new URL(typeof raw === "string" ? raw : safeFallback.href, root);
    return url.origin === root.origin ? url.href : safeFallback.href;
  } catch {
    try {
      return new URL("/", origin).href;
    } catch {
      throw webPushError("WEB_PUSH_SERVICE_WORKER_FAILED");
    }
  }
}

export function registerPushHandlers(scope: Scope, options: PushHandlerOptions = {}): void {
  try {
    scope.addEventListener("push", (value: unknown) => {
      if (!isPushEvent(value)) throw webPushError("WEB_PUSH_SERVICE_WORKER_FAILED");
      const event = value;
      const { title, options: notification } = buildNotification(
        parsePushPayload(event.data),
        options,
      );
      event.waitUntil(
        workerOperation(() => scope.registration.showNotification(title, notification)),
      );
    });

    scope.addEventListener("notificationclick", (value: unknown) => {
      if (!isClickEvent(value)) throw webPushError("WEB_PUSH_SERVICE_WORKER_FAILED");
      const event = value;
      event.waitUntil(
        workerOperation(async () => {
          event.notification.close();
          const target = resolveClickUrl(
            event.notification.data,
            scope.location.origin,
            options.defaultUrl,
          );
          const windows = await scope.clients.matchAll({
            type: "window",
            includeUncontrolled: true,
          });
          const exact = windows.find((client) => client.url === target);
          if (exact) return exact.focus();
          const any = windows[0];
          if (any) {
            await any.navigate?.(target);
            return any.focus();
          }
          return scope.clients.openWindow(target);
        }),
      );
    });
  } catch {
    throw webPushError("WEB_PUSH_SERVICE_WORKER_FAILED");
  }
}

async function workerOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw webPushError("WEB_PUSH_SERVICE_WORKER_FAILED");
  }
}

function isPushEvent(value: unknown): value is PushEventLike {
  if (
    typeof value !== "object" ||
    value === null ||
    !("waitUntil" in value) ||
    typeof value.waitUntil !== "function" ||
    !("data" in value)
  )
    return false;
  const data = value.data;
  return (
    data === null ||
    (typeof data === "object" &&
      data !== null &&
      "json" in data &&
      typeof data.json === "function" &&
      "text" in data &&
      typeof data.text === "function")
  );
}
function isClickEvent(value: unknown): value is ClickEventLike {
  if (
    typeof value !== "object" ||
    value === null ||
    !("waitUntil" in value) ||
    typeof value.waitUntil !== "function" ||
    !("notification" in value)
  )
    return false;
  const notification = value.notification;
  return (
    typeof notification === "object" &&
    notification !== null &&
    "close" in notification &&
    typeof notification.close === "function"
  );
}
