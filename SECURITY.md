# Security

## Reporting

Report vulnerabilities in `@operatornest/convex-web-push` through the package repository’s Security tab (Report a vulnerability) or [operatornest+security@gmail.com](mailto:operatornest+security@gmail.com). Include the affected version, operation, code path, redacted reproduction and impact. Remove credentials, keys, endpoints, payloads, customer data and personal information. Keep exploit details private until maintainers coordinate disclosure.

The app authenticates and authorizes callers before invoking `WebPush`. Report paths that bypass those boundaries or disclose component credentials prefixed `WEB_PUSH_`.

## Boundaries

- The deployed VAPID private key is read from component env, never from arguments, and never stored, logged or returned. `subscriptions.readApplicationServerKey` returns the configured public key; `generateVapidKeys` returns a newly generated pair. `deliveries.verify` returns configuration problems and fixed check error messages without key material.
- Endpoints and subscription keys are sensitive. Removal requires a matching `userId`; notification and delivery reads require the notification owner. Batch IDs must not be exposed to end users. Public app functions derive user IDs from authenticated `tokenIdentifier`; the component trusts app authorization.
- Recording and sending require an allowed HTTPS host without credentials, custom ports, IP literals or trailing hostname dots. Sending rejects redirects. `allowedPushHosts` extends the outbound trust boundary.
- RFC 8291 encryption uses a fresh ephemeral P-256 key and salt per message. Push errors contain fixed messages and optional HTTP status, never response bodies or endpoint URLs.
- Rotating the VAPID public key makes subscriptions registered with the old key ineligible. Browsers must subscribe and record again. An old attempt cannot update a refreshed subscription revision.
