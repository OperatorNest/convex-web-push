# 0002: VAPID environment variables

VAPID configuration uses `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`. Test mode and parallelism use `WEB_PUSH_TEST_MODE` and `WEB_PUSH_MAX_PARALLELISM`. VAPID keys have no live/test marker; test mode bypasses push requests regardless of the configured key pair.
