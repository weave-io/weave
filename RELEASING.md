# Releasing

This document describes how to publish new versions of `@weaveio/*` packages to npm.

## Overview

Weave uses [Changesets](https://github.com/changesets/changesets) for version management and GitHub Actions for automated publishing. The flow is:

1. **Add changesets** as you work — each PR that changes publishable code includes a changeset file
2. **When ready to release** — run `bun run version` locally to consume changesets, bump versions, and update changelogs
3. **Commit and merge** the version bump to `main`
4. **Create a GitHub Release** — triggers the publish workflow that pushes to npm

## Authorization

Publishing is gated by `main` branch merge permissions. Every step in the release flow requires the ability to merge to `main`:

- Adding a changeset requires merging a PR to `main`
- Committing version bumps requires merging to `main`
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

### 2. Apply version bumps locally

When you're ready to cut a release, run:

```bash
bun run version
```

This consumes all pending changeset files, bumps `package.json` versions, and updates `CHANGELOG.md` in each affected package. Review the changes, commit them, and merge to `main`.

### 3. Create a GitHub Release

Go to **Releases → Draft a new release** on GitHub (or use the CLI):

```bash
gh release create v<version> --title "v<version>" --generate-notes
```

Use a tag like `v0.1.0` matching the primary package version. The release event is what triggers publishing, not the tag name.

### 4. Publish happens automatically

The **Release** workflow (`release.yml`) triggers on the `published` event and:

1. Builds and tests the code (separate job)
2. Runs `bunx changeset publish` to publish all packages with bumped versions to npm
3. Uses npm provenance (OIDC) for supply-chain integrity

## Preview / Snapshot Packages

Weave also publishes preview packages from `main` so you can try unreleased changes before a full release.

Every push to `main` runs the snapshot workflow. The workflow checks for pending changesets and only publishes if unreleased changes exist. If there are no pending changesets (e.g. after committing a version bump), the workflow exits without publishing.

Preview packages use the `preview` dist-tag. Install them with:

```bash
bun add @weaveio/weave-core@preview
```

Equivalent commands work for the other public packages:

- `bun add @weaveio/weave-engine@preview`
- `bun add @weaveio/weave-config@preview`
- `bun add @weaveio/weave-cli@preview`
- `bun add @weaveio/weave-adapter-opencode@preview`
- `bun add @weaveio/weave-adapter-claude-code@preview`

Snapshot versions include a timestamp suffix. For example:

```text
0.1.0-preview-20260708145500
```

Two details matter:

- Preview publishing requires a pending changeset. A push to `main` without a changeset produces no snapshot packages.
- Each new snapshot overwrites the `preview` dist-tag, so `@preview` always points to the latest snapshot only.

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

### Publish failed

Check the Release workflow logs. Common issues:
- `WEAVEIO_NPM_TOKEN` secret is missing or expired
- A package version already exists on npm (versions are immutable)
- Build or test failure in the `build-and-test` job

### Publishing a single package

Changesets handles multi-package publishing automatically. If only one package has a changeset, only that package (and its dependents, if `updateInternalDependencies` is set) will be bumped and published.

---

## Adapter-specific shipping

### `@weaveio/weave-adapter-opencode`

Ships as an npm package loaded directly by OpenCode's plugin system. Users do **not** run `npm install` — they pin the versioned package in their `opencode.json` and OpenCode fetches it from npm at startup:

```json
{
  "plugin": [
    "@weaveio/weave-adapter-opencode@<version>"
  ]
}
```

For preview versions:

```json
{
  "plugin": [
    "@weaveio/weave-adapter-opencode@0.0.0-preview-20260708134505"
  ]
}
```

### `@weaveio/weave-adapter-claude-code`

Ships in **two channels**:

| Channel | What | How |
|---------|------|-----|
| **npm** | `@weaveio/weave-adapter-claude-code` — the composition engine used by `weave compose` | Published via Changesets alongside other packages |
| **Claude Code marketplace** | `weave-bootstrap` — a static plugin that triggers recomposition on session start | Submitted to `anthropics/claude-plugins-community` via their review process |

#### npm publishing

The adapter package follows the standard Changesets flow — add a changeset, bump, release. It's a build-time dependency of `@weaveio/weave-cli`.

#### Claude Code marketplace plugin

The bootstrap plugin lives at `packages/adapters/claude-code/src/bootstrap/` and is a static directory (no build step). To submit or update it:

1. Ensure the bootstrap files are current (`plugin.json`, `hooks/hooks.json`, `skills/compose/SKILL.md`)
2. Run `claude plugin validate ./packages/adapters/claude-code/src/bootstrap` to verify structure
3. Submit via [console.anthropic.com/plugins/submit](https://platform.claude.com/plugins/submit)
4. The marketplace pins to a commit SHA; pushing new commits auto-bumps the pin after CI passes

The bootstrap plugin version (`plugin.json` → `version`) should be bumped manually when its behavior changes (new hooks, changed compose command, etc.). It is independent of the npm package version.

#### User setup flow

```bash
# Install CLI (provides weave compose command)
bun add -D @weaveio/weave-cli

# First-time project setup
weave compose --adapter claude-code --init

# Inside Claude Code (one-time, if marketplace plugin is published)
/plugin install weave-bootstrap

# Or without marketplace — use --plugin-dir flags
claude --plugin-dir ./weave-bootstrap-plugin --plugin-dir .weave/plugins/claude-code
```

After marketplace install, daily use is just `claude` — the SessionStart hook handles everything.
