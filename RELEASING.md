# Releasing Weave

Weave has one trusted stable publisher: `.github/workflows/release-publish.yml`.
The separate `.github/workflows/release-attest.yml` workflow attests artifacts. It
is not reusable and is never an npm trusted-publisher identity.

## Rules

- Publish only bytes bound to the merged `main` commit (`releasedSha`).
- Treat workflow artifacts as cache. Recompute source, plan, audit, and registry
  state when a run starts or resumes.
- Never add an npm token to Actions. The publish job uses npm trusted publishing
  through OIDC.
- Never unpublish, overwrite a version, move `latest` backward, or deprecate a
  version from CI. Fix a bad release forward on `main`.
- The publish job has no GitHub App token. The refs and cleanup job owns the App
  token and runs after registry verification.

The checked-in rollout declaration and `RELEASE_ROLLOUT_MODE` are one gate. In
Task 25, `pre-cutover` plus `disabled` exits before build work. `dry-run` runs
the proof chain but skips publish and OIDC. Only `ready` plus `enabled` with the
observed approved topology can publish.

## Merge to publish

1. Prepare and merge a stable release PR with the `release:stable` label into
   protected `main`.
2. The `route` job validates the repository, closed event, main lineage, label,
   rollout tuple, and authorization. It tries to delete `release-pr/stable` on
   both merged and unmerged close paths. A failed delete records
   `MarkerCleanupPending`; a merged release still continues.
3. `recompute` rereads the merged source, release plan, ledger, changelogs, and
   audit. A stored plan or workflow artifact never overrides this authority.
4. `build-bind` builds at `releasedSha` and binds the tarball digests.
5. `await-attest` dispatches the independent attestation workflow with only
   source, plan, run, artifact, and digest identifiers. It blocks on a missing,
   pending, failed, or digest-mismatched check.
6. `consumer-proof` installs the exact tarballs in clean consumers. Then
   `harness-proof` runs all five changed-adapter proof stages.
7. The protected `release` environment approves the complete proof summary.
8. Only the `publish` job receives `id-token: write`. It invokes
   `publish-main.ts`, which publishes the already-bound tarballs.
9. `registry-verification` reads every public version and compares its digest.
   `refs-cleanup` then creates create-once tags and releases and opens the
   changeset-cleanup PR with the App token.

The job graph is a straight chain. A failed step is safe to rerun because the
publisher, refs, and cleanup operations are idempotent and each step rereads
authority.

## `next` prerelease

Use `channel: next` to test a bounded set of packages from the current green
`main`. This is a maintainer-only manual dispatch. Select one or more of the
four required checkboxes (`cli`, `opencode`, `claude-code`, and `pi`); no model
or thinking input is accepted. The route requires the `workflow_dispatch`
event, `refs/heads/main`, the `weave-io/weave` repository, and Task 9
maintainer authorization. The route summary records the seed and the computed
closure.

The controller closes the seed over shared changesets and bundled-artifact
impacts, using the same closure rules as stable. It does not consume or delete
changesets. It builds at the current `main` SHA and computes
`<stable>-next.YYYYMMDD.sha12` in UTC. Version, dependency-range, and
changelog changes exist only in the staging tree. The source checkout's
package manifests and changelogs are byte-checked before and after packing;
the checkout must remain unchanged.

Each staged tarball contains a bounded, deterministic scratch changelog. It
has the fixed current-prerelease notice, package/version/source identity,
source history, pending changeset IDs and digests, and the canonical notes URL.
It contains no model prose. The canonical stable changelog is not changed.
The workflow also retains the deterministic notes artifact for the GitHub
prerelease.

`next` uses the same ordered chain as stable: independent exact attestation,
clean-consumer proof for every closure member, and all five harness-proof
stages for every changed adapter. Missing, skipped, or mismatched evidence
blocks before the protected `prerelease` environment and before OIDC. Approval
is enforced by that workflow environment; it is not an npm trusted-publisher
environment claim. Only `publish` has `id-token: write`, and it publishes the
bound bytes with npm's `next` dist-tag. Registry verification runs before refs.
The final job creates immutable, create-once GitHub prerelease entries and tags with the
deterministic wrapper and pending-changeset identities. It never moves
`latest`.

Rerun the same dispatch after a transient failure. Recompute and exact digest
proof remain authoritative. Existing matching registry bytes, tags, and
prereleases are skipped; conflicts stop the run. Do not edit source files,
consume changesets, or create a manual stable changelog entry to repair a
`next` run.

## `nightly` channel (manual path only)

Task 27 adds a maintainer-guarded `channel: nightly` option to the trusted
workflow. It has no schedule trigger. The old `publish.yml` schedule remains
the only scheduled publisher. Planned schedule activation belongs to Task 35;
do not treat this manual path as active scheduled nightly publication.

Nightly reads the latest successful nightly source SHA from the registry and
computes the affected package set since that SHA. It closes the set over shared
changesets and bundled-artifact dependencies. It does not consume or delete
changesets. If the set is empty, the run records `NothingToPublish` and exits
green without build, attestation, proof, OIDC, registry, or Git ref work.

For a non-empty set, the controller creates
`<stable>-nightly.YYYYMMDD.sha12` versions. Version and dependency overrides
exist only in the staging tree. Changelogs are deterministic scratch snapshots;
nightly does not call an AI model or mutate source manifests or canonical
changelogs. Every affected package requires independent exact attestation and
clean-consumer proof. Every affected adapter requires minimum and latest host
proof. Missing, skipped, or mismatched evidence blocks before OIDC.

`disabled` is a typed early exit. `dry-run` runs the complete build and proof
chain but skips publish and OIDC. An eventual enabled run uses the trusted
workflow's `nightly` dist-tag, verifies registry digests, and creates no Git
tags or releases. Schedule activation is a later rollout decision, not part of
Task 27.

## Resume

Dispatch `.github/workflows/release-publish.yml` with `channel: stable-resume`
and the merged `released_sha`. Resume recomputes the release and runs only the
remaining Task 14 transitions:

- pending artifacts rebuild and reprove;
- pending npm publishes only missing or digest-matching members;
- pending registry verification rereads the registry;
- pending tags or releases creates only missing refs;
- pending changeset cleanup opens or reuses only the cleanup PR;
- terminal releases with `MarkerCleanupPending` perform marker cleanup after
  proving the associated PR is merged or closed.

Artifact expiry is not release authority. If a published member exists, the
registry digest and provenance control the decision; an expired artifact must
be rebuilt and compared. If a member was not published, a fresh binding must
pass independent attestation, consumer proof, and harness proof before publish.
Resume succeeds with no cached artifacts when the source and registry ports are
available.

Normal resume refuses `IntegrityIncident` except for safe marker cleanup. It
never publishes an unreproducible byte or crosses the incident state.

## Integrity incidents

Dispatch the guarded `incident-resolution` channel in the protected `release`
environment. The interactive operation has three phases:

1. **Generate:** verify the immutable registry digest and provenance, write a
   bounded nonsecret authorization record, and print exact shell-escaped
   `npm deprecate` commands. CI stops with `IncidentDeprecationPending`.
2. **Interactive recovery:** an authorized maintainer runs those commands in a
   local authenticated npm session with the required MFA. CI does not receive
   the credentials and does not run the commands.
3. **Complete:** dispatch again. The controller reads each immutable version's
   `deprecated` field and requires the exact message. Only then does it record
   the warning, safe tags/releases, check evidence, and cleanup, producing
   `CompleteWithIncident`.

The incident path never deprecates, publishes, unpublishes, or moves `latest`
from a workflow. Missing or wrong readback remains an incident. Publish a new
fix-forward patch from `main` after recovery.

## Stable release PRs

Use `release-stable-prepare.yml` to create one stable PR. Use
`release-stable-regenerate.yml` when `main` advances. The marker is an active PR
lock, not publication authority. Do not delete it manually or create a second
stable PR. The doctor and resume paths report and clear creation cleanup or
marker cleanup only after authoritative checks.

## Verification commands

Run these before changing a release workflow:

```bash
bun scripts/release/publish-reachability.ts
bun scripts/ci/verify-action-pins.ts
actionlint .github/workflows/release-publish.yml .github/workflows/release-attest.yml
bun run docs:check-links
```

The reachability check rejects alternate publish entrypoints, reusable callers,
permission broadening, `npm deprecate` command paths, and production access to
test-only incident fixtures.
