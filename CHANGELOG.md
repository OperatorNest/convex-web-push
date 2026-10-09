# @operatornest/convex-web-push

## 0.2.0

### Minor Changes

- 356e40d: The repository was re-created with a clean history; package code and API are unchanged from 0.1.1. The maintainer provider check is now `pnpm e2e` where provided; this repository has no maintainer provider script.

## 0.1.1

### Patch Changes

- Publish from GitHub Actions through npm trusted publishing, with signed npm provenance attestations. No API or behavior changes.

## 0.1.0

### Minor Changes

- Initial release: Web Push for Convex with RFC 8291 encryption and RFC 8292 VAPID on WebCrypto; durable delivery through `@convex-dev/workpool` with TTL-aware retries and automatic pruning of dead subscriptions; bounded batch sends that continue in scheduled mutations; typed `WEB_PUSH_*` errors with an exported guard; `onComplete` callbacks as typed function handles; browser and service worker helpers; a VAPID key CLI; a runtime self-test; and an explicit test mode.
