import { base64urlDecode, bytesEqual } from "../shared/base64url.js";
import { isWebPushError, webPushError } from "../shared/errors.js";

/** A serialized push subscription contains its endpoint, expiration time and encryption keys. */
export type PushSubscriptionJSON = {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
};

/** Permission state records browser notification permission or unsupported push messaging. */
export type PermissionState = NotificationPermission | "unsupported";

/** Registration options select an existing service worker or its script path. */
export type RegistrationOptions = {
  registration?: ServiceWorkerRegistration;

  serviceWorkerPath?: string;
};

/** Subscription options select the application server key and service worker registration. */
export type SubscribeOptions = RegistrationOptions & {
  applicationServerKey: string;
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
  options: RegistrationOptions = {},
): Promise<PushSubscriptionJSON | null> {
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
export function subscribe(options: SubscribeOptions): Promise<PushSubscriptionJSON> {
  return browserOperation(() => subscribeImpl(options));
}
export function getSubscription(
  options: RegistrationOptions = {},
): Promise<PushSubscriptionJSON | null> {
  return browserOperation(() => getSubscriptionImpl(options));
}
export function unsubscribe(options: RegistrationOptions = {}): Promise<string | null> {
  return browserOperation(() => unsubscribeImpl(options));
}
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  try {
    if (value.length > 88) throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
    return base64urlDecode(value);
  } catch {
    throw webPushError("WEB_PUSH_INVALID_ARGUMENT");
  }
}
