# 0012: Serialized subscription and browser helper type names

The serialized subscription has one name in every entry point: `PushSubscriptionJSON`, the W3C name for the shape `PushSubscription.toJSON()` returns. The client no longer exports a `PushSubscription` type, which shadowed the live W3C interface.

The browser permission union, which adds `unsupported` to `NotificationPermission`, is `PushPermission`, returned by `getPushPermission()`, instead of `PermissionState`, which names the Permissions API union; no DOM type is named `PushPermission`. The registration selector is `ServiceWorkerScopeOptions` instead of `RegistrationOptions`, which named the options of `ServiceWorkerContainer.register()`. The service worker parses payloads as `Partial<PushNotification>` instead of a separate `PushPayload` type.

Exported validators are named `<concept>Validator`, for example `pushSubscriptionValidator`, so a validator and the type it checks share one concept word.
