# Repository rules

Read `README.md`, `CONTRIBUTING.md`, `SECURITY.md` and `docs/adr/`. Read the local Convex API guidelines at `example/convex/_generated/ai/guidelines.md` before changing Convex functions. Generated AI files are local and gitignored.

## Package boundaries

`@operatornest/convex-web-push` mounts as `webPush` with a `workpool` child. Its only runtime dependency is `@convex-dev/workpool`; `convex` and `convex-helpers` are peers.

| Path                             | Responsibility                                                      |
| -------------------------------- | ------------------------------------------------------------------- |
| `src/component/`                 | Schema, functions, queue and cleanup.                               |
| `src/client/`                    | App-facing WebPush client, types and validators.                    |
| `src/shared/`                    | Encryption, signing, admission, bounds, errors and retry logic.     |
| `src/browser/`, `src/sw/`, `sw/` | Browser helpers and module/classic service workers.                 |
| `src/test.ts`                    | Consumer convex-test registration without Vite ambient types.       |
| `example/convex/`                | Authenticated public wrappers and internal administrative wrappers. |
| `bin/`, `scripts/`               | Node CLI and development checks.                                    |

## Runtime and authorization

- Authored `src/` uses Web APIs: no `"use node"`, Node built-ins, `Buffer` or `process`.
- Read deployed VAPID keys only through generated `env`; never accept the deployed private key as an argument or put it in rows, logs, errors or returns.
- Errors on caller-reachable paths use `webPushError`. Add each code, fixed message and README row together. Retain no native exception text, provider body or endpoint in error data.
- App public functions derive `userId` from authenticated `tokenIdentifier`. The component trusts app authorization; functions acting on other users stay internal. Completion callbacks are internal mutations.
- Check endpoint admission during registration and sending; never follow redirects. Add no runtime dependencies except official `@convex-dev/*` components.
- Resolve test mode only with `isTestMode`; missing credentials never enable it. Non-test sends fail closed. Batch continuations preserve resolved test mode and recheck configuration and the public-key fingerprint.
- Each attempt captures a subscription revision. Completion updates health only for the same owner and revision. Purge continuations delete only earlier registration generations.
- Workpool parallelism comes only from `WEB_PUSH_MAX_PARALLELISM`; retries come only from `planRetry`.

## Source invariants

- Public functions declare `args` and `returns`; reuse shared validators and `schema.doc`.
- No `v.any()`, non-null assertions, `as unknown as` or TODOs in authored `src/`. Generated bindings are exempt.
- Client calls copy declared fields explicitly; caller objects must not override component arguments.
- Reads use indexes and bounds. Index names list every field in order joined by `_and_`. Use `paginator` with `boundedPage` for history, including endCursor requests. Never use native `.paginate()` in a component or unbounded `.collect()`.
- No `Date.now()` in queries or large Promise.all fan-outs in mutations.
- Validate stored string and array bounds before decoding or storing them. Text cuts use `truncateText` so no surrogate pair is split.
- Comments state only constraints the code cannot express. Existing lint suppressions require a next-line reason; add no suppression to pass a check.

## Generated bindings and tools

Never hand-edit `src/component/_generated/` or `example/convex/_generated/`. Initialize a fresh checkout with `CONVEX_AGENT_MODE=anonymous pnpm exec convex init`, then regenerate with `pnpm build:codegen`. Review tracked generated changes with their source inputs. `dist/` is ignored build output.

Use Node 24 and pnpm 12.9.1 through mise. TypeScript 7 builds; TypeScript 6 supports tooling. `exactOptionalPropertyTypes` remains off in the package until convex-helpers pagination compiles with it.

Do not edit `pnpm-workspace.yaml`, `knip.json`, `.github/workflows/`, `.mise.toml` or `scripts/with-local-lock.mjs`. Preserve coverage thresholds. Source gates enforce module-scope randomness, index names and client argument spreads.

## Verification

Run affected tests and formatting first. Component, schema or shared-runtime changes require `pnpm build:codegen`, `pnpm check` and `pnpm smoke`. Client changes require affected client tests and `pnpm check`. Tooling changes also require `pnpm audit --prod --audit-level high`. Markdown-only changes require `pnpm fmt:check`; executable docs require affected example tests and smoke when they claim runtime behavior.

Tests use generated keys and stubbed fetch, never production keys or real push services. Restore fake timers in afterEach; use vi.setSystemTime for time. Vitest resolves the package client to authored source.

`build:codegen` and `smoke` take the shared local lock. Smoke removes inherited deployment selectors, starts an isolated anonymous local backend and deletes its workspace. It does not prove live-provider or physical-browser behavior.

Report each executed check and exit code. Publishing, pushing, deploying and registry submissions require explicit authorization. Update README behavior and errors with public changes; add an ADR for contract changes.
