import { base64urlDecode, bytesEqual } from "../shared/base64url.js";
import { isWebPushError, webPushError } from "../shared/errors.js";
import type { PushSubscriptionJSON } from "../shared/validators.js";

export type { PushSubscriptionJSON } from "../shared/validators.js";

/** Push permission state records browser notification permission or unsupported push messaging. */
export type PushPermission = NotificationPermission | "unsupported";

/** Service worker scope options select an existing service worker registration or its script path. */
export type ServiceWorkerScopeOptions = {
  registration?: ServiceWorkerRegistration;

  serviceWorkerPath?: string;
};

/** Subscription options select the application server key and service worker registration. */
export type SubscribeOptions = ServiceWorkerScopeOptions & {
  applicationServerKey: string;
};

/** Report whether the browser exposes service workers, the Push API and notifications. */
export function isSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in globalThis &&
    "Notification" in globalThis
  );
}

/** Read the notification permission, or "unsupported" when push messaging is unavailable. */
export function getPushPermission(): PushPermission {
  return isSupported() ? Notification.permission : "unsupported";
}

const ACTIVATION_TIMEOUT_MS = 10_000;

function waitForActive(
  registration: ServiceWorkerRegistration,
  timeoutMs = ACTIVATION_TIMEOUT_MS,
): Promise<void> {
  if (registration.active) return Promise.resolve();
  const pending = registration.installing ?? registration.waiting;
  if (!pending) return Promise.reject(webPushError("WEB_PUSH_SERVICE_WORKER_FAILED"));
  const worker: ServiceWorker = pending;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener("statechange", onChange);
      reject(webPushError("WEB_PUSH_SERVICE_WORKER_FAILED"));
    }, timeoutMs);
    function onChange() {
      if (worker.state === "activated") {
        clearTimeout(timer);
        worker.removeEventListener("statechange", onChange);
        resolve();
      } else if (worker.state === "redundant") {
        clearTimeout(timer);
        worker.removeEventListener("statechange", onChange);
        reject(webPushError("WEB_PUSH_SERVICE_WORKER_FAILED"));
      }
    }
    worker.addEventListener("statechange", onChange);
  });
}

async function resolveRegistration(
  options: ServiceWorkerScopeOptions,
): Promise<ServiceWorkerRegistration> {
  let registration: ServiceWorkerRegistration;
  try {
    registration =
      options.registration ??
      (await navigator.serviceWorker.register(options.serviceWorkerPath ?? "/sw.js"));
  } catch {
    throw webPushError("WEB_PUSH_SERVICE_WORKER_FAILED");
  }
  await waitForActive(registration);
  return registration;
}

function toJSON(subscription: PushSubscription): PushSubscriptionJSON {
  const json = subscription.toJSON();
  const { p256dh, auth } = json.keys ?? {};
  if (!json.endpoint || !p256dh || !auth) throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}

async function subscribeImpl(options: SubscribeOptions): Promise<PushSubscriptionJSON> {
  if (!isSupported()) throw webPushError("WEB_PUSH_UNSUPPORTED");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw webPushError("WEB_PUSH_PERMISSION_DENIED");

  const registration = await resolveRegistration(options);
  const keyBytes = urlBase64ToUint8Array(options.applicationServerKey);
  let subscription = await registration.pushManager.getSubscription();
  const existingKey = subscription?.options.applicationServerKey;
  if (subscription && existingKey && !bytesEqual(new Uint8Array(existingKey), keyBytes)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes,
  });
  return toJSON(subscription);
}

async function getSubscriptionImpl(
  options: ServiceWorkerScopeOptions = {},
): Promise<PushSubscriptionJSON | null> {
  if (!isSupported()) return null;
  const registration =
    options.registration ??
    (await navigator.serviceWorker.getRegistration(options.serviceWorkerPath));
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? toJSON(subscription) : null;
}

async function unsubscribeImpl(options: ServiceWorkerScopeOptions = {}): Promise<string | null> {
  if (!isSupported()) return null;
  const registration =
    options.registration ??
    (await navigator.serviceWorker.getRegistration(options.serviceWorkerPath));
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return null;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}

async function browserOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isWebPushError(error)) throw error;
    throw webPushError("WEB_PUSH_BROWSER_FAILED");
  }
}

/** Request permission, register the service worker and return the serialized push subscription. */
export function subscribe(options: SubscribeOptions): Promise<PushSubscriptionJSON> {
  return browserOperation(() => subscribeImpl(options));
}

/** Return the existing serialized push subscription, or null when none exists or push is unsupported. */
export function getSubscription(
  options: ServiceWorkerScopeOptions = {},
): Promise<PushSubscriptionJSON | null> {
  return browserOperation(() => getSubscriptionImpl(options));
}

/** Unsubscribe the existing push subscription and return its endpoint, or null when none exists. */
export function unsubscribe(options: ServiceWorkerScopeOptions = {}): Promise<string | null> {
  return browserOperation(() => unsubscribeImpl(options));
}

/** Decode a base64url application server key of at most 88 characters into bytes. */
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  try {
    if (value.length > 88) throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
    return base64urlDecode(value);
  } catch {
    throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  }
}
