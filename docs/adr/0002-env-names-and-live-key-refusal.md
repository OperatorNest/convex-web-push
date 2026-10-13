# 0002: VAPID environment variables

Component configuration uses `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_VAPID_SUBJECT`, `WEB_PUSH_TEST_MODE` and `WEB_PUSH_MAX_PARALLELISM`. `readConfig` parses every supplied value and malformed values raise `WEB_PUSH_NOT_CONFIGURED`. Only absent parallelism defaults to 10. Non-test operations require the VAPID key pair and contact URI.

VAPID keys have no live/test marker in RFC 8292. Test mode simulates push service acceptance without network requests regardless of the configured pair. There is no provider sandbox or recognizable live credential, so no live-key refusal code applies.
