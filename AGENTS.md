The package is `@operatornest/convex-web-push`, component name `webPush`.

## Scope

Read [README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and `docs/adr/` before changing behavior. Domain terms and status transitions are defined in [Concepts](README.md#concepts).

The client groups are `config`, `subscriptions`, `notifications` and `deliveries`; each group calls its same-named component module. `src/component/` owns rows, functions, queues and cleanup. `src/client/` owns the app-facing client. `src/shared/` owns encryption, signing, admission, bounds, errors and retries. `src/browser/`, `src/sw/` and `sw/` own browser helpers and service workers. `src/test.ts` registers the component with convex-test. `example/convex/` demonstrates authenticated public functions and internal administration. `bin/` and `scripts/` own the Node CLI and development checks.

## Runtime and security boundaries

- Authored `src/` uses Web APIs; no Node built-ins, `Buffer`, `process` or `"use node"`.
- The only runtime dependency is `@convex-dev/workpool`; `convex` and `convex-helpers` are peers. Add no runtime dependencies except official `@convex-dev/*` components.
- Read deployed VAPID keys through generated component env. Never accept the deployed private key as an argument or put it in rows, logs, errors or returns.
- Parse component env with `readConfig`; malformed values raise `WEB_PUSH_NOT_CONFIGURED`. Resolve test mode with `resolveTestMode`; unset means live; live operations without VAPID configuration raise `WEB_PUSH_NOT_CONFIGURED`. Missing credentials never enable test mode.
- Public app functions derive `userId` from authenticated `tokenIdentifier`. The component trusts app authorization. Functions acting on other users and completion callbacks stay internal.
- Store resolved `testMode` on every affected row. Reads isolate users and test modes. Batch continuations preserve the resolved value and recheck configuration and the public-key fingerprint.
- Check endpoint admission during registration and sending; never follow redirects. Each attempt captures a subscription revision. Completion updates health only for the same user, test mode and revision. Purge continuations delete only earlier registration generations.
- Workpool parallelism comes only from `WEB_PUSH_MAX_PARALLELISM`; retries come only from `planRetry`.
- Caller-visible errors use `webPushError` with one fixed message per code. Add the code, message and README Errors row together. Retain no native exception text, provider body or endpoint in error data.

## Query and validator patterns

- Public component functions declare `args` and `returns`; reuse shared validators and `schema.doc`.
- No `v.any()`, non-null assertions, `as unknown as` or TODOs in authored source; generated bindings are exempt.
- Client calls copy declared fields explicitly and pass omitted optionals as `undefined`; caller objects cannot override component arguments.
- Exported validators are named `<concept>Validator`.
- Reads use indexes and bounds. Index names list every field in order joined by `_and_`. Indexes for user reads include `testMode` after `userId`.
- Use `paginator` with `boundedPage` for notification history, including endCursor requests. Never use native `.paginate()` in a component or unbounded `.collect()`.
- No `Date.now()` in queries or large Promise.all fan-outs in mutations.
- Validate stored string and array bounds before decoding or storing them. Use `truncateText` so text cuts preserve surrogate pairs.
- Export status unions and the closed `DELIVERY_ERROR_KINDS` union, and document each public method and type with one TSDoc sentence. Other comments state only constraints the code cannot express. Add no lint suppression to pass a check.

## Generated files

Read `example/convex/_generated/ai/guidelines.md` before changing Convex functions. Generated AI files are local and gitignored.

Never hand-edit `src/component/_generated/` or `example/convex/_generated/`. Initialize a fresh checkout with `CONVEX_AGENT_MODE=anonymous pnpm exec convex init`, then regenerate with `pnpm build:codegen`. Inspect tracked generated changes alongside their source inputs. `dist/` is ignored build output.

## Toolchain and verification

Use Node 24 and pnpm 12.9.1 through mise. TypeScript 7 builds; TypeScript 6 supports tooling. Keep strict, unchecked-index, override and fallthrough checks enabled. No tsconfig sets `exactOptionalPropertyTypes`, so it stays off: convex-helpers pagination ships TypeScript source that fails it.

Preserve coverage thresholds and the canonical source checks. Do not change `pnpm-workspace.yaml`, `knip.json` or `scripts/with-local-lock.mjs`.

Run affected tests and formatting first. Component, schema and shared runtime changes require `pnpm build:codegen`, `pnpm check` and `pnpm smoke`. Client changes require affected client tests and `pnpm check`. Tooling changes also require `pnpm audit --prod --audit-level high`. Markdown changes require `pnpm fmt:check`; executable examples require affected example tests and smoke for runtime claims.

Tests use generated keys and stubbed fetch, never production keys or real push services, and assert package errors with `expectWebPushError`. Restore fake timers in afterEach and use vi.setSystemTime for time. Vitest resolves the package client to authored source.

Codegen and smoke take the shared local lock. Smoke removes inherited deployment selectors, starts an isolated anonymous local backend and deletes its workspace. It does not prove live-provider or physical-browser behavior.

Report executed checks and exit codes. Publishing, pushing, deploying and registry submissions require explicit authorization. Update README behavior and errors with public changes; add an ADR for public API or schema changes.
