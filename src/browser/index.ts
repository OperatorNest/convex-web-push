import { base64urlDecode, bytesEqual } from "../shared/base64url.js";
import { isWebPushError, webPushError } from "../shared/errors.js";

export type WebPushSubscriptionJSON = {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
};

export type PermissionState = NotificationPermission | "unsupported";

export type RegistrationOptions = {
  registration?: ServiceWorkerRegistration;

  serviceWorkerPath?: string;
};

export type SubscribeOptions = RegistrationOptions & {
  vapidPublicKey: string;
};

export function isSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in globalThis &&
    "Notification" in globalThis
  );
}

export function permissionState(): PermissionState {
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
  options: RegistrationOptions,
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

function toJSON(subscription: PushSubscription): WebPushSubscriptionJSON {
  const json = subscription.toJSON();
  const { p256dh, auth } = json.keys ?? {};
  if (!json.endpoint || !p256dh || !auth) throw webPushError("WEB_PUSH_INVALID_SUBSCRIPTION");
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}

async function subscribeImpl(options: SubscribeOptions): Promise<WebPushSubscriptionJSON> {
  if (!isSupported()) throw webPushError("WEB_PUSH_UNSUPPORTED");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw webPushError("WEB_PUSH_PERMISSION_DENIED");

  const registration = await resolveRegistration(options);
  const applicationServerKey = urlBase64ToUint8Array(options.vapidPublicKey);
  let subscription = await registration.pushManager.getSubscription();
  const existingKey = subscription?.options.applicationServerKey;
  if (
    subscription &&
    existingKey &&
    !bytesEqual(new Uint8Array(existingKey), applicationServerKey)
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
  return toJSON(subscription);
}

async function getSubscriptionImpl(
  options: RegistrationOptions = {},
): Promise<WebPushSubscriptionJSON | null> {
  if (!isSupported()) return null;
  const registration =
    options.registration ??
    (await navigator.serviceWorker.getRegistration(options.serviceWorkerPath));
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? toJSON(subscription) : null;
}

async function unsubscribeImpl(options: RegistrationOptions = {}): Promise<string | null> {
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
export function subscribe(options: SubscribeOptions): Promise<WebPushSubscriptionJSON> {
  return browserOperation(() => subscribeImpl(options));
}
export function getSubscription(
  options: RegistrationOptions = {},
): Promise<WebPushSubscriptionJSON | null> {
  return browserOperation(() => getSubscriptionImpl(options));
}
export function unsubscribe(options: RegistrationOptions = {}): Promise<string | null> {
  return browserOperation(() => unsubscribeImpl(options));
}
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  try {
    if (value.length > 88) throw webPushError("WEB_PUSH_INVALID_VAPID_KEY");
    return base64urlDecode(value);
  } catch {
    throw webPushError("WEB_PUSH_INVALID_VAPID_KEY");
  }
}
