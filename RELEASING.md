# Releasing Weave

Weave uses a **tag-trigger model**: push a tag, and the workflow publishes to npm.

## How to cut a release

1. **Bump the version** in the package's `package.json`:
   ```bash
   # Example: releasing @weaveio/weave-cli
   cd packages/cli
   # Edit package.json, change "version": "1.2.3" to "1.2.4"
   ```

2. **Commit the version bump**:
   ```bash
   git add packages/cli/package.json
   git commit -m "chore(cli): bump version to 1.2.4"
   ```

3. **Push to main**:
   ```bash
   git push origin main
   ```

4. **Create and push an annotated tag**:
   ```bash
   git tag -a cli@1.2.4 -m "Release cli 1.2.4"
   git push origin cli@1.2.4
   ```

   **Important**: The tag commit must exactly equal the current `origin/main` commit. The workflow will validate this and fail if they differ.

The workflow (`.github/workflows/publish-tag.yml`) will detect the tag, build the package, publish it to npm, and create a GitHub Release with auto-generated release notes.

## Tag naming convention

Each package has a unique tag prefix:

| Package | Tag prefix | Example tag | npm package name |
|---------|-----------|-------------|------------------|
| CLI | `cli@` | `cli@1.2.4` | `@weaveio/weave-cli` |
| OpenCode adapter | `opencode@` | `opencode@0.3.1` | `@weaveio/weave-adapter-opencode` |
| Claude Code adapter | `claude-code@` | `claude-code@0.2.0` | `@weaveio/weave-adapter-claude-code` |

**Format**: `<prefix>@<semver>` where `<semver>` is `major.minor.patch` (e.g. `1.2.3`).

**Note**: The Pi adapter (`@weaveio/weave-adapter-pi`) is developed and released separately from a private repository. It is not part of this public release workflow.

## Duplicate versions (idempotent skip)

If you push a tag for a version that already exists on npm, the workflow will skip publishing and exit successfully. This makes the workflow idempotent: you can safely re-run or re-tag without side effects.

## How to verify a release

1. **Check the workflow run**:
   - Go to the [Actions tab](https://github.com/weave-io/weave/actions/workflows/publish-tag.yml)
   - Find the run triggered by your tag
   - Verify all jobs passed (green checkmarks)

2. **Check npm**:
   ```bash
   npm view @weaveio/weave-cli version
   # Should show the version you just published
   ```

3. **Install and test**:
   ```bash
   npm install -g @weaveio/weave-cli@1.2.4
   weave --version
   ```

## Secret setup (maintainers only)

The workflow uses the existing repository Actions secret `WEAVEIO_NPM_TOKEN`.

### Verifying or updating the secret

1. **Check the secret exists**:
   - Go to the repository **Settings** → **Secrets and variables** → **Actions**
   - Verify `WEAVEIO_NPM_TOKEN` is listed under **Repository secrets**

2. **If the token needs rotation**:
   - Log in to [npmjs.com](https://www.npmjs.com/)
   - Go to **Access Tokens** in your account settings
   - Click **Generate New Token** → **Automation**
   - Scope: **Publish** (allows publishing new versions of existing packages only)
   - Automation tokens bypass 2FA and are designed for CI/CD

3. **Update the repository secret**:
   - In **Settings** → **Secrets and variables** → **Actions**, click **WEAVEIO_NPM_TOKEN**
   - Click **Update secret**
   - Paste the new token value
   - Click **Update secret**

4. **Verify the token scope**:
   - The token must be scoped to the `@weaveio` organization
   - Minimum required permission: publish new versions of existing packages
   - The token should **not** have permission to unpublish or deprecate

## Migration note

The previous OIDC/attestation/proof pipeline was removed in favor of this simpler model. The old workflows (`release-publish.yml`, `release-attest.yml`, `release-stable-prepare.yml`, `release-stable-regenerate.yml`) and their associated scripts are no longer used.

## Workflow reference

The publish workflow is defined in [`.github/workflows/publish-tag.yml`](.github/workflows/publish-tag.yml).
