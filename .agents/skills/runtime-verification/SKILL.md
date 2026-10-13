---
name: runtime-verification
description: Contributor guidance for runtime verification.
---

# Runtime verification

Read `AGENTS.md`, package scripts, and `scripts/smoke.mjs` before choosing checks.

1. Run affected tests, including client or example tests for consumer behavior, then `pnpm check`.
2. For component, schema, or generated API changes, initialize with `CONVEX_AGENT_MODE=anonymous pnpm exec convex init`, then run `pnpm build:codegen` and `pnpm smoke`. Commit regenerated bindings with their authored inputs; never edit generated files by hand.
3. For executable documentation, run its code path or the closest example and `pnpm fmt:check`. Prose-only changes need formatting verification.
4. Distinguish simulator, anonymous local runtime, and external provider or browser observations. Local smoke does not qualify a provider account.

No script calls live push services.

The scripts serialize local backend access through a shared lock. Do not terminate another checkout's backend.
