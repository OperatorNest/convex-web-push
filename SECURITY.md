# Security

Report suspected vulnerabilities through GitHub private vulnerability reporting:
[report a vulnerability](https://github.com/OperatorNest/convex-web-push/security/advisories/new).
You can also write to [operatornest+security@gmail.com](mailto:operatornest+security@gmail.com).
Include the affected version, the code path, a minimal reproduction and the impact. Remove real
VAPID private keys and real subscription endpoints from the report.

Do not publish exploit details in an issue or pull request before maintainers have assessed the
report.

## What the component protects

- **The VAPID private key.** It signs every push request. It lives only in the component env var
  `VAPID_PRIVATE_KEY`; it is never accepted as an argument, stored in a table, logged or returned
  (`selfTest` reports booleans and check names only). A leaked key lets anyone send pushes to your
  subscribers' browsers as you; rotate it (subscriptions made under the old key are then marked
  gone).
- **Subscription endpoints.** An endpoint is a capability URL: knowing it, plus the subscriber's
  keys, is enough to send to that browser, and knowing the endpoint is enough to call
  `removeSubscription` unless you pass `userId`. Treat stored subscriptions as sensitive data.
- **The outbound request.** Endpoints come from untrusted browsers, so the component is an SSRF
  boundary. Only `https` URLs on known push service hosts (or your `allowedPushHosts`), with no
  credentials, custom port, IP literal or `localhost`, are accepted, both when recording and again
  when sending, and redirects are not followed.
- **Payloads.** Encrypted end to end with a fresh ephemeral key and salt per message (RFC 8291).

## What your app owns

`userId` is an opaque string you supply. The component does not authenticate callers: derive it
from your own auth in the app functions that wrap the client.

## Reports we want

Bypasses of the endpoint allowlist, any path that exposes or logs the private key, signature or
encryption flaws, and ways to send to a subscription of another user.
