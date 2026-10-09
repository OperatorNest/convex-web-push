import { base64urlDecode, bytesEqual } from "../shared/base64url.js";
import { webPushError } from "../shared/errors.js";

/** Framework-agnostic browser helpers. Call `subscribe` from a user gesture (a click handler). */

export type WebPushSubscriptionJSON = {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
};

export type PermissionState = NotificationPermission | "unsupported";

export type RegistrationOptions = {
  /** Reuse an existing service worker registration. */
  registration?: ServiceWorkerRegistration;
  /**
   * Path of the service worker script to register when no registration is given. Default `/sw.js`.
   * Serve it from the page's origin; its scope must cover the page that calls `subscribe`.
   */
  serviceWorkerPath?: string;
};

export type SubscribeOptions = RegistrationOptions & {
  /** The VAPID public key from `webPush.getPublicKey`. */
  vapidPublicKey: string;
};

/** False in non-installed iOS Safari tabs, where Web Push needs the app added to the Home Screen. */
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

/**
 * Resolves once the registration has an active worker. Unlike `navigator.serviceWorker.ready`
 * this watches the given registration, so a worker whose scope does not cover the page cannot
 * hang the call forever.
 */
function waitForActive(
  registration: ServiceWorkerRegistration,
  timeoutMs = ACTIVATION_TIMEOUT_MS,
): Promise<void> {
  if (registration.active) return Promise.resolve();
  const pending = registration.installing ?? registration.waiting;
  if (!pending)
    return Promise.reject(
      webPushError(
        "WEB_PUSH_SERVICE_WORKER_FAILED",
        "The service worker registration has no worker",
      ),
    );
  const worker: ServiceWorker = pending;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener("statechange", onChange);
      reject(
        webPushError(
          "WEB_PUSH_SERVICE_WORKER_FAILED",
          "The service worker did not activate in time. Check that it is served from your origin and that its scope covers this page.",
        ),
      );
    }, timeoutMs);
    function onChange() {
      if (worker.state === "activated") {
        clearTimeout(timer);
        worker.removeEventListener("statechange", onChange);
        resolve();
      } else if (worker.state === "redundant") {
        clearTimeout(timer);
        worker.removeEventListener("statechange", onChange);
        reject(
          webPushError(
            "WEB_PUSH_SERVICE_WORKER_FAILED",
            "The service worker became redundant (installation failed)",
          ),
        );
      }
    }
    worker.addEventListener("statechange", onChange);
  });
}

async function resolveRegistration(
  options: RegistrationOptions,
): Promise<ServiceWorkerRegistration> {
  const registration =
    options.registration ??
    (await navigator.serviceWorker.register(options.serviceWorkerPath ?? "/sw.js"));
  await waitForActive(registration);
  return registration;
}

function toJSON(subscription: PushSubscription): WebPushSubscriptionJSON {
  const json = subscription.toJSON();
  const { p256dh, auth } = json.keys ?? {};
  if (!json.endpoint || !p256dh || !auth)
    throw webPushError(
      "WEB_PUSH_INVALID_SUBSCRIPTION",
      "The browser returned an incomplete push subscription",
    );
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}

/**
 * Registers the service worker, asks for permission, and subscribes to push. Returns the
 * subscription JSON to pass to your app mutation that calls `recordSubscription`.
 */
export async function subscribe(options: SubscribeOptions): Promise<WebPushSubscriptionJSON> {
  if (!isSupported())
    throw webPushError("WEB_PUSH_UNSUPPORTED", "Web Push is not supported in this browser");
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw webPushError("WEB_PUSH_PERMISSION_DENIED", `Notification permission was ${permission}`);

  const registration = await resolveRegistration(options);
  const applicationServerKey = base64urlDecode(options.vapidPublicKey);
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

/** The current browser subscription, or null. Compare it with the server on each app load. */
export async function getSubscription(
  options: RegistrationOptions = {},
): Promise<WebPushSubscriptionJSON | null> {
  if (!isSupported()) return null;
  const registration =
    options.registration ??
    (await navigator.serviceWorker.getRegistration(options.serviceWorkerPath));
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? toJSON(subscription) : null;
}

/** Unsubscribes this browser. Returns the removed endpoint so you can call `removeSubscription`. */
export async function unsubscribe(options: RegistrationOptions = {}): Promise<string | null> {
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

export { base64urlDecode as urlBase64ToUint8Array };
