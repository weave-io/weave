# Releasing

This document describes how to publish new versions of `@weaveio/*` packages to npm.

## Overview

Weave uses [Changesets](https://github.com/changesets/changesets) for version management and GitHub Actions for automated publishing. The flow is:

1. **Add a changeset** describing what changed
2. **Merge to `main`** — the Version workflow opens a "Version Packages" PR
3. **Merge the version PR** — this bumps `package.json` versions and updates changelogs
4. **Create a GitHub Release** — triggers the publish workflow that pushes to npm

## Authorization

Publishing is gated by `main` branch merge permissions. Every step in the release flow requires the ability to merge to `main`:

- Adding a changeset requires merging a PR to `main`
- The version PR must be merged to `main`
- Creating a GitHub Release requires Write access to the repository

No additional approval gates are needed — if you can merge to `main`, you're authorized to release.

## Step-by-step

### 1. Add a changeset

After making changes, add a changeset describing the bump:

```bash
bun run changeset
```

This interactive prompt asks which packages changed and whether the bump is `patch`, `minor`, or `major`. It creates a markdown file in `.changeset/` — commit it with your PR.

**Manual alternative:** create a file like `.changeset/my-change.md`:

```md
---
"@weaveio/weave-core": patch
"@weaveio/weave-engine": minor
---

Brief description of what changed
```

### 2. Merge your PR

Once your PR (with the changeset file) merges to `main`, the **Version** workflow (`version.yml`) runs automatically. It:

- Consumes all pending changeset files
- Bumps versions in `package.json` files
- Updates `CHANGELOG.md` in each package
- Opens a PR titled **"chore: version packages"**

If there are no pending changesets, the workflow is a no-op.

### 3. Merge the version PR

Review the version PR to confirm the bumps are correct, then merge it. This commits the version changes to `main`.

### 4. Create a GitHub Release

Go to **Releases → Draft a new release** on GitHub (or use the CLI):

```bash
gh release create v<version> --title "v<version>" --generate-notes
```

Use a tag like `v0.1.0` matching the primary package version, or any descriptive tag — the release event is what triggers publishing, not the tag name.

### 5. Publish happens automatically

The **Release** workflow (`release.yml`) triggers on the `published` event and:

1. Builds and tests the code (separate job)
2. Runs `bunx changeset publish` to publish all packages with bumped versions to npm
3. Uses npm provenance (OIDC) for supply-chain integrity

## Quick reference

| Action | Command |
|--------|---------|
| Add changeset | `bun run changeset` |
| Check pending bumps | `bunx changeset status` |
| Apply version bumps locally | `bun run version` |
| Dry-run publish | `bunx changeset publish --dry-run` |

## Troubleshooting

### "No packages to bump"

Run `bunx changeset status`. If it reports no packages, you haven't added a changeset file yet. Add one with `bun run changeset`.

### Version PR not appearing

The Version workflow only runs on pushes to `main`. Check that:
- Your changeset file was merged (not just committed to a branch)
- The workflow ran successfully in **Actions → Version**

### Publish failed

Check the Release workflow logs. Common issues:
- `WEAVEIO_NPM_TOKEN` secret is missing or expired
- A package version already exists on npm (versions are immutable)
- Build or test failure in the `build-and-test` job

### Publishing a single package

Changesets handles multi-package publishing automatically. If only one package has a changeset, only that package (and its dependents, if `updateInternalDependencies` is set) will be bumped and published.
