# Releasing Weave

Weave uses a **tag-trigger model**: push a tag, and the workflow publishes to npm.

A tag push is the release. Nothing between the push and `npm publish` asks for
confirmation, and a published npm version can never be reused, even after
unpublishing. Agents: see [Releasing as an agent](#releasing-as-an-agent) for
the checks to run before and after the push.

## How to cut a release

1. **Bump the version in a PR.** `main` is protected by a ruleset: changes land
   through a pull request and are squash-merged. Put the bump in its own PR (or
   the last PR before the release), with a changeset in `.changeset/` describing
   the user-visible change. The publish workflow does not read changesets.
   ```bash
   # Example: releasing @weaveio/weave-cli 1.2.4
   git switch -c chore/cli-release-1-2-4 origin/main
   # Edit packages/cli/package.json: "version": "1.2.3" → "1.2.4"
   git commit -am "chore(cli): prepare 1.2.4"
   git push -u origin chore/cli-release-1-2-4
   gh pr create --fill
   ```

2. **Wait for the PR to merge**, then fetch and confirm the bump is on `origin/main`:
   ```bash
   git fetch origin main --tags
   git show origin/main:packages/cli/package.json | jq -r .version   # → 1.2.4
   ```

3. **Tag the `origin/main` commit, not your local `HEAD`**, and push the tag:
   ```bash
   git tag -a cli@1.2.4 -m "Release cli 1.2.4" origin/main
   git push origin cli@1.2.4
   ```

   **Important**: when the workflow runs, it checks that the tag commit equals
   `origin/main` and that the package's `package.json` version equals the tag
   version. It fails before publishing if either check fails. The usual cause is
   a tag pushed before the bump PR merged, which leaves the tag on the commit
   before the bump. The other cause is another PR merging between the tag push
   and the workflow run. See [Recovering from a failed run](#recovering-from-a-failed-run).

The workflow (`.github/workflows/publish-tag.yml`) runs the full test suite,
builds, publishes the package to npm, and creates a GitHub Release with
auto-generated notes.

## Tag naming convention

Each package has a unique tag prefix:

| Package | Tag prefix | Example tag | npm package name |
|---------|-----------|-------------|------------------|
| CLI | `cli@` | `cli@1.2.4` | `@weaveio/weave-cli` |
| OpenCode adapter | `opencode@` | `opencode@0.3.1` | `@weaveio/weave-adapter-opencode` |
| OpenCode 2 adapter | `opencode2@` | `opencode2@0.2.0` | `@weaveio/weave-adapter-opencode2` |
| Claude Code adapter | `claude-code@` | `claude-code@0.2.0` | `@weaveio/weave-adapter-claude-code` |

**Format**: `<prefix>@<semver>` where `<semver>` is `major.minor.patch` (e.g. `1.2.3`), or `major.minor.patch-next.N` for a pre-release (e.g. `1.3.0-next.0`).

**Note**: The Pi adapter (`@weaveio/weave-adapter-pi`) is developed and released separately from a private repository. It is not part of this public release workflow.

## Pre-releases

A version with a `-next.N` suffix is published to the `next` npm dist-tag instead of `latest`, and its GitHub Release is marked as a pre-release. Users who install `@latest` or an unpinned version keep the current stable release; testers opt in with `@next` or the exact version:

```bash
bun add --global @weaveio/weave-cli@next
bun add --global @weaveio/weave-cli@1.3.0-next.0
```

The steps are the same as a stable release: bump `package.json` to `1.3.0-next.0` in a PR, wait for it to merge, then tag the new `origin/main` commit `cli@1.3.0-next.0` and push the tag. Increment `N` for each follow-up pre-release. To promote, release `1.3.0` as usual; `latest` moves to it and `next` stays on the last pre-release until the next one.

## Duplicate versions

If you push a tag for a version that already exists on npm, the publish step
logs a notice and skips `npm publish`. Nothing is published twice. The next
step, `gh release create`, still fails if a GitHub Release for the tag already
exists. So re-running a fully successful release is harmless, but the run ends
red.

## Releasing as an agent

An agent can run a release end to end with `git`, `gh`, `jq` and `npm`. The
tag push publishes to npm immediately and can't be undone. Before pushing it,
make sure the human has named the package and the version (or channel), for
example "release opencode2 as the next pre-release". If they haven't, ask.

Set the release variables first. The prefix, directory and npm name come from
the [tag naming table](#tag-naming-convention) and must match the `case` in
`.github/workflows/publish-tag.yml`:

```bash
PREFIX=opencode2
DIR=packages/adapters/opencode2
NAME=@weaveio/weave-adapter-opencode2
VERSION=0.2.0-next.1
TAG="$PREFIX@$VERSION"
```

1. **Pre-flight.** Both checks must come back empty. Otherwise the version is
   taken, so pick the next one.
   ```bash
   npm view "$NAME@$VERSION" version       # empty (npm prints a 404 on stderr)
   git ls-remote --tags origin "$TAG"      # empty
   npm view "$NAME" dist-tags              # current latest/next, for the summary
   ```

2. **Bump the version in a PR and merge it.** Branch from `origin/main`, set
   `"version"` in `$DIR/package.json`, add a changeset, open the PR, and
   squash-merge it once CI passes. Wait for the merge to finish. `gh pr merge`
   can return before GitHub has updated `main`:
   ```bash
   gh pr merge <number> --squash --delete-branch
   gh pr view <number> --json state,mergeCommit --jq '.state + " " + .mergeCommit.oid'   # MERGED <sha>
   ```

3. **Gate on `origin/main`.** Resolve the exact commit to tag and prove it
   carries the bump. Don't tag your local `HEAD` or a commit from memory.
   ```bash
   git fetch origin main --tags
   SHA=$(git rev-parse origin/main)
   test "$(git show "$SHA:$DIR/package.json" | jq -r .version)" = "$VERSION" \
     && echo "ok: $SHA carries $VERSION" \
     || echo "STOP: origin/main does not carry $VERSION yet"
   ```

4. **Tag and push.** Don't merge anything else to `main` until the run has
   passed its "Validate tag commit equals origin/main" step (a few seconds after
   it starts).
   ```bash
   git tag -a "$TAG" -m "Release $PREFIX $VERSION" "$SHA"
   git push origin "$TAG"
   ```

5. **Watch the run.** The run can take a few seconds to show up after the push.
   Retry the lookup until it returns an ID:
   ```bash
   RUN=$(gh run list --repo weave-io/weave --workflow publish-tag.yml \
     --branch "$TAG" --limit 1 --json databaseId --jq '.[0].databaseId')
   gh run watch "$RUN" --repo weave-io/weave --exit-status
   ```
   On failure, read the failing step with `gh run view "$RUN" --repo weave-io/weave --log-failed`
   and follow [Recovering from a failed run](#recovering-from-a-failed-run).

6. **Verify.** npm says "may take a few minutes to become available", so a
   missing dist-tag right after a green run is expected. Poll before you
   conclude anything:
   ```bash
   CHANNEL=latest; case "$VERSION" in *-next.*) CHANNEL=next ;; esac
   until [ "$(npm view "$NAME" "dist-tags.$CHANNEL" --prefer-online 2>/dev/null)" = "$VERSION" ]; do sleep 10; done
   gh release view "$TAG" --repo weave-io/weave --json isPrerelease,url
   ```

Report the npm version and dist-tag, the GitHub Release URL, and the workflow
run URL.

## Recovering from a failed run

What to do depends on whether anything reached npm. Check that first:

```bash
npm view "$NAME@$VERSION" version --prefer-online   # empty = not published
```

**Not published** (failed at tag format, tag commit, `package.json` version,
Test, Build, or at Publish without the version appearing on npm). The tag can
be moved safely:

1. Fix the cause. That can mean waiting for the bump PR to merge, or landing a
   fix through a PR.
2. Delete the tag locally and on the remote, then repeat steps 3–6 above:
   ```bash
   git push origin ":refs/tags/$TAG"
   git tag -d "$TAG"
   ```

Pushing the re-created tag starts a fresh run. `gh run rerun` only helps with
transient failures (a network error, an npm outage) while the tag commit still
equals `origin/main`. A rerun checks out the same commit and compares it with
the current `main` again.

**Published** (the version is on npm). The tag and the version are now fixed:

- Never move or delete the tag, and never publish a different commit under the
  same version.
- If only the "Create GitHub Release" step failed, create the release by hand
  with the workflow's flags. Add `--prerelease` for `-next.N` versions:
  ```bash
  gh release create "$TAG" --repo weave-io/weave --title "$NAME v$VERSION" \
    --generate-notes --latest=false --prerelease
  ```
- If the published package is broken, release the next version: `-next.N+1`
  for a pre-release, or the next patch for a stable release.

## How to verify a release

1. **Check the workflow run**:
   - Go to the [Actions tab](https://github.com/weave-io/weave/actions/workflows/publish-tag.yml)
   - Find the run triggered by your tag
   - Verify all jobs passed (green checkmarks)

2. **Check npm** (allow a few minutes for the registry to update):
   ```bash
   npm view @weaveio/weave-cli dist-tags
   # `latest` (stable) or `next` (pre-release) should show the version you just published
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
