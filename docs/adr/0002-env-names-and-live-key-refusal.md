# 0002: Env names kept, live-key refusal not applicable

## Context

Component-specific tuning uses `WEB_PUSH_` names. Test mode must avoid provider calls. VAPID keys are ecosystem-standard under the names `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (other Web Push tooling and docs use them), and a VAPID key
pair is an arbitrary P-256 key with no live or test prefix.

## Decision

Keep `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`. Test mode and tuning use the
prefixed names `WEB_PUSH_TEST_MODE` and `WEB_PUSH_MAX_PARALLELISM`. Test mode does not refuse
configured VAPID keys, because nothing marks a key as live.

## Consequences

Apps may already have the `VAPID_*` names in use for another component and need to bind them
explicitly. Test mode never calls a push service, so a live key present in a test-mode deployment
is not used to send.
