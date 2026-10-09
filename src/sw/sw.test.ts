import { expect, test, vi } from "vitest";
import { required } from "../test-helpers.js";
import swSource from "../../sw/convex-web-push-sw.js?raw";
import {
  buildNotification,
  parsePushPayload,
  registerPushHandlers,
  resolveClickUrl,
} from "./index.js";

const origin = "https://app.example.com";

function handlerFor(listeners: Map<string, (event: unknown) => void>, type: string) {
  return required(listeners.get(type), `a ${type} listener`);
}

function makeScope(
  windows: {
    url: string;
    focus: () => Promise<unknown>;
    navigate?: (u: string) => Promise<unknown>;
  }[] = [],
) {
  const listeners = new Map<string, (event: unknown) => void>();
  const scope = {
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    registration: { showNotification: vi.fn(async () => {}) },
    clients: {
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => {}),
      claim: vi.fn(async () => {}),
    },
    location: { origin },
    skipWaiting: vi.fn(),
  };
  return { scope, listeners };
}

function pushEvent(data: { json: () => unknown; text: () => string } | null) {
  const waits: Promise<unknown>[] = [];
  return {
    event: { data, waitUntil: (p: Promise<unknown>) => waits.push(p) },
    settle: () => Promise.all(waits),
  };
}

function clickEvent(data: unknown) {
  const waits: Promise<unknown>[] = [];
  const close = vi.fn();
  return {
    event: { notification: { close, data }, waitUntil: (p: Promise<unknown>) => waits.push(p) },
    close,
    settle: () => Promise.all(waits),
  };
}

test("parses JSON, plain text and empty payloads", () => {
  expect(parsePushPayload({ json: () => ({ title: "t" }), text: () => "" })).toEqual({
    title: "t",
  });
  expect(
    parsePushPayload({
      json: () => {
        throw new Error("no");
      },
      text: () => "plain",
    }),
  ).toEqual({ body: "plain" });
  expect(parsePushPayload(null)).toEqual({});
});

test("builds notification options and drops renotify without a tag", () => {
  const built = buildNotification({
    title: "Hi",
    body: "b",
    url: "/inbox",
    renotify: true,
    data: { id: 1 },
  });
  expect(built.title).toBe("Hi");
  expect(built.options.renotify).toBeUndefined();
  expect(built.options.data).toEqual({ url: "/inbox", extra: { id: 1 } });
  expect(buildNotification({ tag: "x", renotify: true }).options.renotify).toBe(true);
  expect(buildNotification({}, { defaultTitle: "Fallback" }).title).toBe("Fallback");
});

test("only same-origin click targets are followed", () => {
  expect(resolveClickUrl({ url: "/a?b=1" }, origin)).toBe(`${origin}/a?b=1`);
  expect(resolveClickUrl({ url: "https://evil.example/x" }, origin)).toBe(`${origin}/`);
  expect(resolveClickUrl({ url: "javascript:alert(1)" }, origin)).toBe(`${origin}/`);
  expect(resolveClickUrl(undefined, origin, "/home")).toBe(`${origin}/home`);
});

test("module handlers show a notification on push and focus a matching window on click", async () => {
  const focus = vi.fn(async () => {});
  const { scope, listeners } = makeScope([{ url: `${origin}/inbox`, focus }]);
  registerPushHandlers(scope, { defaultIcon: "/icon.png" });

  const push = pushEvent({ json: () => ({ title: "Hello", url: "/inbox" }), text: () => "" });
  handlerFor(listeners, "push")(push.event);
  await push.settle();
  expect(scope.registration.showNotification).toHaveBeenCalledWith(
    "Hello",
    expect.objectContaining({ icon: "/icon.png", data: { url: "/inbox", extra: undefined } }),
  );

  const click = clickEvent({ url: "/inbox" });
  handlerFor(listeners, "notificationclick")(click.event);
  await click.settle();
  expect(click.close).toHaveBeenCalled();
  expect(focus).toHaveBeenCalled();
  expect(scope.clients.openWindow).not.toHaveBeenCalled();
});

test("click navigates an existing window or opens a new one", async () => {
  const navigate = vi.fn(async () => {});
  const focus = vi.fn(async () => {});
  const withWindow = makeScope([{ url: `${origin}/other`, focus, navigate }]);
  registerPushHandlers(withWindow.scope);
  const a = clickEvent({ url: "/next" });
  handlerFor(withWindow.listeners, "notificationclick")(a.event);
  await a.settle();
  expect(navigate).toHaveBeenCalledWith(`${origin}/next`);

  const empty = makeScope();
  registerPushHandlers(empty.scope);
  const b = clickEvent({ url: "https://evil.example/x" });
  handlerFor(empty.listeners, "notificationclick")(b.event);
  await b.settle();
  expect(empty.scope.clients.openWindow).toHaveBeenCalledWith(`${origin}/`);
});

function loadClassicWorker(scope: object) {
  // oxlint-disable-next-line typescript/no-implied-eval -- evaluates the shipped classic worker source against a fake scope
  new Function("self", swSource)(scope);
}

test("the bundled classic service worker behaves like the module handlers", async () => {
  const focus = vi.fn(async () => {});
  const { scope, listeners } = makeScope([{ url: `${origin}/inbox`, focus }]);
  loadClassicWorker(scope);

  const push = pushEvent({
    json: () => ({ title: "Classic", body: "b", url: "/inbox" }),
    text: () => "",
  });
  handlerFor(listeners, "push")(push.event);
  await push.settle();
  expect(scope.registration.showNotification).toHaveBeenCalledWith(
    "Classic",
    expect.objectContaining({ body: "b", data: { url: "/inbox", extra: undefined } }),
  );

  const empty = pushEvent(null);
  handlerFor(listeners, "push")(empty.event);
  await empty.settle();
  expect(scope.registration.showNotification).toHaveBeenLastCalledWith(
    "Notification",
    expect.any(Object),
  );

  const click = clickEvent({ url: "/inbox" });
  handlerFor(listeners, "notificationclick")(click.event);
  await click.settle();
  expect(focus).toHaveBeenCalled();

  const bad = clickEvent({ url: "https://evil.example/x" });
  handlerFor(listeners, "notificationclick")(bad.event);
  await bad.settle();
  expect(scope.clients.openWindow).not.toHaveBeenCalled();
});
