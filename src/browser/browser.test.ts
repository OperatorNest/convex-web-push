import { afterEach, expect, test, vi } from "vitest";
import { base64urlDecode } from "../shared/base64url.js";
import { isWebPushError } from "../shared/errors.js";
import { getSubscription, isSupported, permissionState, subscribe, unsubscribe } from "./index.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type SubscribeArgs = { userVisibleOnly: boolean; applicationServerKey: Uint8Array };

const VAPID_KEY =
  "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";

function fakeSubscription(endpoint = "https://fcm.googleapis.com/fcm/send/x", key?: Uint8Array) {
  return {
    endpoint,
    options: { applicationServerKey: key?.buffer ?? null },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "P", auth: "A" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function stubBrowser(
  existing: ReturnType<typeof fakeSubscription> | null,
  permission = "granted",
  makeRegistration?: (pushManager: object) => object,
) {
  const created = fakeSubscription();
  const pushManager = {
    getSubscription: vi.fn(async () => existing),
    subscribe: vi.fn(async (_options: SubscribeArgs) => created),
  };
  const registration = makeRegistration?.(pushManager) ?? { pushManager, active: {} };
  vi.stubGlobal("PushManager", {});
  vi.stubGlobal("Notification", { permission, requestPermission: vi.fn(async () => permission) });
  vi.stubGlobal("navigator", {
    serviceWorker: {
      register: vi.fn(async () => registration),
      ready: new Promise(() => {}),
      getRegistration: vi.fn(async () => registration),
    },
  });
  return { pushManager, registration, created };
}

test("reports unsupported environments", async () => {
  expect(isSupported()).toBe(false);
  expect(permissionState()).toBe("unsupported");
  expect(await getSubscription()).toBeNull();
  expect(await unsubscribe()).toBeNull();
  await expect(subscribe({ vapidPublicKey: VAPID_KEY })).rejects.toMatchObject({
    data: { code: "WEB_PUSH_UNSUPPORTED" },
  });
});

test("subscribe registers the worker and returns serializable JSON", async () => {
  const { pushManager } = stubBrowser(null);
  expect(isSupported()).toBe(true);
  const json = await subscribe({ vapidPublicKey: VAPID_KEY, serviceWorkerPath: "/push-sw.js" });
  expect(json).toEqual({
    endpoint: "https://fcm.googleapis.com/fcm/send/x",
    expirationTime: null,
    keys: { p256dh: "P", auth: "A" },
  });
  expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/push-sw.js");
  const options = pushManager.subscribe.mock.calls[0]?.[0];
  expect(options?.userVisibleOnly).toBe(true);
  expect(options?.applicationServerKey).toEqual(base64urlDecode(VAPID_KEY));
});

test("subscribe reuses a subscription made with the same key and replaces one made with another", async () => {
  const same = fakeSubscription(
    "https://fcm.googleapis.com/fcm/send/same",
    base64urlDecode(VAPID_KEY),
  );
  const reuse = stubBrowser(same);
  expect((await subscribe({ vapidPublicKey: VAPID_KEY })).endpoint).toContain("/same");
  expect(reuse.pushManager.subscribe).not.toHaveBeenCalled();

  const stale = fakeSubscription(
    "https://fcm.googleapis.com/fcm/send/old",
    new Uint8Array(65).fill(4),
  );
  const replace = stubBrowser(stale);
  await subscribe({ vapidPublicKey: VAPID_KEY });
  expect(stale.unsubscribe).toHaveBeenCalled();
  expect(replace.pushManager.subscribe).toHaveBeenCalled();
});

test("subscribe fails when permission is not granted", async () => {
  stubBrowser(null, "denied");
  await expect(subscribe({ vapidPublicKey: VAPID_KEY })).rejects.toMatchObject({
    data: { code: "WEB_PUSH_PERMISSION_DENIED" },
  });
});

test("getSubscription and unsubscribe use the existing subscription", async () => {
  const existing = fakeSubscription();
  stubBrowser(existing);
  expect((await getSubscription())?.endpoint).toBe(existing.endpoint);
  expect(await unsubscribe()).toBe(existing.endpoint);
  expect(existing.unsubscribe).toHaveBeenCalled();
  stubBrowser(null);
  expect(await getSubscription()).toBeNull();
  expect(await unsubscribe()).toBeNull();
});

function fakeWorker(state: string) {
  const listeners = new Set<() => void>();
  return {
    state,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    listening: () => listeners.size > 0,
    transition(next: string) {
      this.state = next;
      for (const l of listeners) l();
    },
  };
}

test("subscribe waits for the registration to activate without using serviceWorker.ready", async () => {
  const worker = fakeWorker("installing");
  const { pushManager } = stubBrowser(null, "granted", (manager) => ({
    pushManager: manager,
    active: null,
    installing: worker,
    waiting: null,
  }));
  const pending = subscribe({ vapidPublicKey: VAPID_KEY });
  await vi.waitFor(() => expect(worker.listening()).toBe(true));
  expect(pushManager.subscribe).not.toHaveBeenCalled();
  worker.transition("activating");
  worker.transition("activated");
  expect((await pending).endpoint).toContain("fcm.googleapis.com");
});

test("subscribe fails with a scope hint if the worker never activates", async () => {
  vi.useFakeTimers();
  stubBrowser(null, "granted", (manager) => ({
    pushManager: manager,
    active: null,
    installing: fakeWorker("installing"),
    waiting: null,
  }));
  const pending = subscribe({ vapidPublicKey: VAPID_KEY });
  const assertion = expect(pending).rejects.toMatchObject({
    data: {
      code: "WEB_PUSH_SERVICE_WORKER_FAILED",
      message: expect.stringContaining("scope covers this page"),
    },
  });
  await vi.advanceTimersByTimeAsync(10_001);
  await assertion;
});

test("subscribe fails if the worker becomes redundant", async () => {
  const worker = fakeWorker("installing");
  stubBrowser(null, "granted", (manager) => ({
    pushManager: manager,
    active: null,
    installing: worker,
    waiting: null,
  }));
  const pending = subscribe({ vapidPublicKey: VAPID_KEY });
  await vi.waitFor(() => expect(worker.listening()).toBe(true));
  worker.transition("redundant");
  await expect(pending).rejects.toMatchObject({
    data: { code: "WEB_PUSH_SERVICE_WORKER_FAILED", message: expect.stringContaining("redundant") },
  });
});

test("browser failures are Web Push errors the guard recognises", async () => {
  const error = await subscribe({ vapidPublicKey: VAPID_KEY }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isWebPushError(error)).toBe(true);
});
