# Contributing

Read [README](README.md) and [AGENTS.md](AGENTS.md) first. Public API changes need an ADR in `docs/adr/`.

## Setup

Development uses Node 24 and pnpm 12 through mise; consumers need Node 24 or newer.

In a fresh checkout:

```sh
mise trust && mise install
mise exec -- pnpm install --frozen-lockfile
CONVEX_AGENT_MODE=anonymous pnpm exec convex init
pnpm build:codegen
```

`build:codegen` and `smoke` use an anonymous local Convex deployment and need no login. Never
configure a cloud deployment for development.

## Checks

```sh
pnpm check
pnpm smoke
```

Run `pnpm smoke` for any change to component functions, schema or shared runtime code:
`convex-test` accepts things the runtime rejects (for example `.paginate()` in a component).

## Change requirements

- Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
  (`feat:`, `fix:`, `docs:`, `test:`, `chore:`); a breaking change adds `!` after the type.
- Until 1.0.0, a breaking change ships without compatibility code, deprecation periods or data
  migrations; its changeset is a `minor` bump that states what breaks.
- Add a changeset for every consumer-visible change to `@operatornest/convex-web-push`.
- Public component functions have `args` and `returns` validators; reads are bounded and indexed.
- Errors on caller-reachable paths come from `webPushError` in `src/shared/errors.ts`; add each
  `WEB_PUSH_` code, its fixed message and its README Errors row together.
- No Node built-ins, `Buffer` or `process` in `src/`. Read provider credentials and master keys
  only through generated component env; never put them in arguments, rows, logs or errors.
- Tests use generated credentials or fixed test-only vectors and stub external requests.
- Regenerate committed bindings from their inputs with `pnpm build:codegen`.
- Update affected examples, README claims and ADR contracts. Run the checks in AGENTS.md and
  report commands and exit codes.

## Bug reports

For a bug report, provide the package, Convex, and Node.js versions, runtime, client method, browser and version, operating system, push service, permission state, service-worker registration state, a minimal reproduction, expected result, and actual result. Remove secrets or credentials (including VAPID private keys and auth tokens), full subscription endpoints or keys, notification contents, recipient data, and personal information from reports and logs. Security reports go through [private vulnerability reporting](https://github.com/OperatorNest/convex-web-push/security/advisories/new).

Follow the [OperatorNest Code of Conduct](https://github.com/OperatorNest/.github/blob/main/CODE_OF_CONDUCT.md) and [support guidance](https://github.com/OperatorNest/.github/blob/main/SUPPORT.md).

## Releasing

1. Add a changeset to each user-facing PR (`pnpm changeset`).
2. A maintainer runs `pnpm changeset version` on a branch and merges it through a PR.
3. On `main`, the Release workflow publishes a `package.json` version that is not on npm yet,
   through npm trusted publishing, after CI and smoke pass on the same commit.

Publishing, pushing, deploying and registry submissions require explicit authorization.
