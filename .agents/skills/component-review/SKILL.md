---
name: component-review
description: Contributor guidance for component review.
---

# Component review

Read `README.md`, `CONTRIBUTING.md`, relevant ADRs, and affected source and tests. Inspect the complete change, including new files.

Trace a representative call through the client, component function, validators, schema or queue, and example app. Check the boundaries the change owns: Convex runtime portability, component environment, app authentication and authorization, validators, bounded indexed reads, VAPID signing, RFC 8291 encryption and push response classification, test-mode separation, errors, exports, generated output, and retention.

For each actionable finding, identify the file and line, reachable behavior, consequence, and fix. Distinguish confirmed defects from unverified concerns. After fixes, run affected checks. Report simulator, local runtime, and external provider evidence separately.
