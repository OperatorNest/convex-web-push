# 0007: sideEffects list and repo-specific tool config

## Context

Most package files are side-effect free. `sw/convex-web-push-sw.js` registers service worker
listeners when evaluated, so a bundler must not drop it. `knip.json` also needs the CLI and
worker files as entry points.

## Decision

- `package.json` has `"sideEffects": ["./sw/convex-web-push-sw.js"]`.
- `knip.json` adds `bin/*.js` and `sw/*.js` as entries and project files so they are analysed.
  `src/browser` and `src/sw` are already entries through the package exports.

## Consequences

Bundlers keep the service worker; every other file stays tree-shakeable. Other tool configuration is unchanged.
