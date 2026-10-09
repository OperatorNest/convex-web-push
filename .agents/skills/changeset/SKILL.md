---
name: changeset
description: Contributor guidance for changeset.
---

# Changeset

Use the package name and release policy in `package.json`, `.changeset/config.json`, and `CONTRIBUTING.md`.

1. Describe consumer-visible behavior, types, entrypoints, defaults, errors, persisted data, or wire-format changes in one appropriate changeset. Include migration steps for incompatible calls.
2. Update an existing entry for the complete change rather than adding incremental notes. Documentation, contributor guidance, templates, and tests alone may need no release; explain that decision in the PR.
3. Compare the entry with the complete diff and verify the package name, bump, and claim. Run `pnpm check`; run `pnpm build:codegen` or `pnpm smoke` when the changed surface requires them.

Never include secrets, provider identifiers, or personal data in release notes.
