---
name: release
description: Contributor guidance for release.
---

# Release

Read `CONTRIBUTING.md`, release and CI workflows, active changesets, `package.json`, and `CHANGELOG.md`. Verify the target branch and public compatibility surface.

1. Confirm release notes cover consumer-visible changes and migration steps. Run `pnpm check`, `pnpm smoke`, `pnpm audit --prod --audit-level high`, and inspect the package file list.
2. Run `pnpm changeset version` on a version branch and review package metadata, consumed entries, and changelog through a PR. CI and smoke must pass on its final commit.
3. When authorized, merge the version PR. The release workflow builds and publishes unpublished versions with npm trusted publishing, then creates the tag and GitHub release.
4. Verify the published package, provenance, tag target, and release notes. Tags must match the published version's `gitHead`; never move a published tag. Report failures at their actual stage.

Publishing, tagging, pushing, and merging require explicit authorization. A passing PR does not prove publication.
