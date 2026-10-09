# Working in this repository

## Scope

Read `README.md`, `CONTRIBUTING.md`, and the ADRs in `docs/adr/` for supported behavior and decisions.

This project uses [Convex](https://convex.dev). **Read `example/convex/_generated/ai/guidelines.md` first** for Convex API rules. The runtime rules below apply to this package.

The package is `@operatornest/convex-web-push`, component name `webPush`. It sends VAPID-signed, RFC 8291-encrypted Web Push notifications using only `fetch` and WebCrypto. Its one runtime dependency is `@convex-dev/workpool`.

| Path                             | Responsibility                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/component/`                 | Schema, functions, cron, config. `webPush` with a `workpool` child.                                                 |
| `src/client/`                    | The `WebPush` class apps use, and the exported validators, types and error guard.                                   |
| `src/shared/`                    | Pure code: `validators`, `errors`, `config`, `vapid`, `encrypt`, `send`, `classify`, `push`, `sha256`, `base64url`. |
| `src/browser/`, `src/sw/`, `sw/` | `/browser` helpers, `/sw` handlers, the copy-paste classic worker.                                                  |
| `bin/convex-web-push.js`         | CLI (`generate-keys`), a wrapper over `dist/shared/cli.js`. May use Node.                                           |
| `src/test.ts`                    | `register(t)` for `convex-test` users.                                                                              |
| `src/test-helpers.ts`            | Shared test helpers (`setupTest`, `configureVapid`, `makeSubscription`, `stubFetch`). Not a test file.              |
| `example/convex/`                | Minimal app using the client. Its functions wrap every client method.                                               |
| `scripts/`                       | Dev-only Node scripts: `smoke.mjs`, `with-local-lock.mjs` (shared, do not edit).                                    |

Main flows:

- **Subscribe.** `subscriptions.record` checks the endpoint host (SSRF allowlist), key lengths, upserts by `by_endpointHash` and stores `vapidKeyFingerprint` of the current public key.
- **Send.** `notifications.send` (or `sendBatch`) validates (`validateSend`: config, payload size, topic), dedupes on `by_user_idempotencyKey`, inserts a `notifications` row and one `deliveries` row per active subscription (at most 50), and enqueues `deliver.run` on the pool from `pool.ts`.
- **Batch.** `sendBatch` handles at most 100 users and 150 deliveries per transaction, then schedules `continueBatch`.
- **Deliver.** `deliver.run` calls `deliveries.begin`, then returns `sent` without network for test-mode rows, otherwise `sendWebPush` encrypts, signs and POSTs, and classifies the response.
- **Complete.** `deliveries.onComplete` plans retries with `planRetry`, updates the delivery, subscription and counts, and schedules the app's `onComplete` through `notifications.invokeCallback`.
- **Cleanup.** `crons.ts` runs `cleanup.run` every 6 hours in bounded batches.

Read the contributor guides in `.agents/skills/` when relevant to the change.

## Runtime and security boundaries

- No `"use node"`, `node:*`, bare Node built-ins, `Buffer` or `process` in authored `src/` files (lint-enforced). `bin/` and `scripts/` may use Node.
- `convex` and `convex-helpers` are peers. Add a runtime dependency only if it is an official `@convex-dev/*` component.
- Secrets live in component env, read through the generated `env`. Never accept them as arguments, store them, log them or put them in errors.
- Fail closed: without VAPID config a non-test send throws `WEB_PUSH_NOT_CONFIGURED`.
- Endpoints are untrusted. Keep the allowlist check at record and send time, and never follow redirects.
- Errors come only from `webPushError` in `src/shared/errors.ts` (codes `WEB_PUSH_*`). No plain `Error` on caller-reachable paths.
- Every public function has `args` and `returns`. No `v.any()`. No non-null `!`, `as unknown as` or TODOs in authored `src/` files. Generated bindings are exempt from these authored-source style rules. Lint suppressions are next-line with a `-- reason`.
- Consumer app functions exposed to clients derive the caller’s `userId` from `ctx.auth`; they must not trust a client-supplied user id. Component functions such as `subscriptions.record` and `notifications.send` accept `userId` because the app owns authentication and authorization. The example follows this: `example/convex/example.ts` is the authenticated public surface, `admin.ts` holds internal server-side functions. `onComplete` callbacks are internal mutations.
- Parallelism comes only from `WEB_PUSH_MAX_PARALLELISM` (workpool's setting is global); never pass it per enqueue.

Bad: let a client-exposed app function accept `userId` to read or send for another user. Good: the consumer app's public function derives the caller's user id from `ctx.auth`, then passes it to the component. Component functions may accept `userId` because the app owns the authorization boundary.

## Query and validator patterns

Bounded, indexed reads, with the real index names:

```ts
const recent = await ctx.db
  .query("notifications")
  .withIndex("by_user_createdAt", (q) => q.eq("userId", userId))
  .order("desc")
  .take(50);
```

Never `.collect()` an unbounded table, and never `.paginate()` in a component; use `paginator` from `convex-helpers`.

Reuse the validators in `src/shared/validators.ts` and `schema.doc`:

```ts
export const listForUser = query({
  args: { userId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("notifications")),
  handler: (ctx, { userId, paginationOpts }) =>
    paginator(ctx.db, schema)
      .query("notifications")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate(paginationOpts),
});
```

No `Date.now()` in queries, and no large `Promise.all` fan-outs in mutations.

## Generated files

The `src/component/_generated/` and `example/convex/_generated/` bindings are generated output, excluded from authored-source lint rules. Edit their schema/function inputs, regenerate, review the diff, and commit changed tracked generated output with the source change. `dist/` remains ignored build output.

Never hand-edit `src/component/_generated/` or `example/convex/_generated/`. In a fresh checkout run `CONVEX_AGENT_MODE=anonymous pnpm exec convex init` first; then `pnpm build:codegen` generates the component API, builds, then generates the example API on the anonymous local backend (no login). If types are stale, regenerate.

## Environment and test behavior

Component env (all optional strings): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `WEB_PUSH_TEST_MODE`, `WEB_PUSH_MAX_PARALLELISM`. Names are kept per [ADR 0002](docs/adr/0002-env-names-and-live-key-refusal.md).

Test mode is opt-in only: client option `testMode: true` or `WEB_PUSH_TEST_MODE=true`, resolved by `isTestMode` in `src/shared/config.ts` and nowhere else. Rows are tagged `testMode: true`.

Tests use `vi.stubEnv` with generated keys (`configureVapid()`), `setupTest({ testMode: false })` for real sending, fake timers restored in `afterEach`, `vi.setSystemTime` for time, and `stubFetch` for push services. Never call real push services or use production keys. Vitest aliases the package name to `src/client/index.ts`, so example and client tests cover the source.

## Toolchain

Node 26 and pnpm 12.9.1 via mise (`.mise.toml`); consumers need Node 22.19+. `pnpm-workspace.yaml`, `.oxlintrc.json`, `knip.json`, the workflows and `scripts/with-local-lock.mjs` are shared files: do not edit them. TypeScript 7 (`@typescript/native`) builds; TypeScript 6 stays for tooling. `exactOptionalPropertyTypes` is off for an upstream reason ([ADR 0001](docs/adr/0001-exact-optional-property-types.md)).

## Verification by change type

Start with affected tests and formatting, then run the required gate. `pnpm build:codegen` and `pnpm smoke` start or use the anonymous local backend under the shared lock; they cost more than `pnpm test` or `pnpm fmt:check`. Do not claim live-provider or browser verification from this local smoke run.

`pnpm smoke` runs the example in the real Convex runtime on the anonymous local backend, because `convex-test` accepts things the runtime rejects. `build:codegen` and `smoke` take the shared lock through `scripts/with-local-lock.mjs`. The smoke script removes the env it sets.

| Change                                      | Required verification                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Component functions, schema, shared runtime | `pnpm build:codegen`, `pnpm check`, `pnpm smoke`.                                             |
| Client behavior or exported surface         | affected client tests, `pnpm check`.                                                          |
| Tooling, configuration, repo-wide rules     | `pnpm check`, and `pnpm audit --prod --audit-level high`.                                     |
| Prose-only Markdown                         | `pnpm fmt:check`.                                                                             |
| Executable docs or API claims               | `pnpm fmt:check`, affected example/client tests; `pnpm smoke` if runtime behavior is claimed. |

There is no live-provider workflow: no real push service is called by any script.

Coverage is a ratchet: the thresholds in `vitest.config.js` may hold or rise, never fall. `pnpm test` enforces the current floor; review threshold changes against the prior commit and add meaningful tests when coverage drops.

## Contribution boundaries

Keep changes scoped. Update README tables and the error table when public behaviour changes, and add an ADR for contract exceptions. Report the exact checks run. Publishing, pushing, deploying and registry submissions need explicit authorization.
