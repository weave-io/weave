# Releases

Weave uses a source-bound, artifact-first release pipeline. The trusted
publisher is `.github/workflows/release-publish.yml`. The independent
`.github/workflows/release-attest.yml` workflow creates artifact provenance and
a digest-bound check; it is top-level, non-reusable, and never npm-trusted.

See [`RELEASING.md`](../../RELEASING.md) for the operator runbook. This page
defines the authority and security boundaries contributors must preserve.

## Publication chain and authority

The stable chain is:

```text
route → recompute → build-bind → await-attest → consumer-proof
      → harness-proof → release-approval → publish
      → registry-verification → refs-cleanup
```

`route` accepts only a closed stable PR or a maintainer-authorized
`stable-resume` or `incident-resolution` dispatch on `refs/heads/main`. It
validates the checked-in rollout stage, `RELEASE_ROLLOUT_MODE`, and observed
workflow topology before work starts. The Task 25 file has no schedule trigger
and no `workflow_call` trigger.

A closed stable PR deletes the `release-pr/stable` marker whether it merged or
not. A deletion failure is recorded as `MarkerCleanupPending`; a merged release
does not stop. The marker is an active-PR lock, never release authority.

`recompute` is the authority boundary. It rereads the merged commit, manifests,
ledger, changelogs, plan, audit, and registry state. Workflow artifacts,
comments, check summaries, and cached plans are evidence or cache only. Resume
uses the same recompute boundary, so a successful rerun does not depend on old
artifact availability.

`build-bind` creates the candidate bytes at `releasedSha`. `await-attest` then
dispatches the independent workflow with nonsecret identifiers. It accepts only
a completed success whose check result contains the exact released SHA, plan
digest, and every tarball digest. Missing, pending, failed, or foreign results
block consumer proof, harness proof, environment approval, and publish.

The `release` environment approval follows all proof jobs. Only the `publish`
job in the trusted workflow has `id-token: write`, and it has no App
installation token. It invokes the existing `publish-main.ts` entrypoint. The
`refs-cleanup` job mints a short-lived App installation token from protected
`release-app` credentials only after every registry digest is verified. It
creates tags and releases without updating an existing conflicting ref, then
opens the changeset-cleanup PR.

## The `next` channel

`next` is a guarded manual operation in the same trusted workflow. The caller
sets `channel: next` and exactly four boolean package inputs: `cli`,
`opencode`, `claude-code`, and `pi`. At least one must be true. The route
accepts only `workflow_dispatch` on `weave-io/weave` at `refs/heads/main` and
requires Task 9 maintainer authorization. It explains the selected seed and
its closure in the workflow summary.

The closure uses the stable shared-changeset and bundled-artifact rules. The
controller reads current green `main`, computes
`<stable>-next.YYYYMMDD.sha12` in UTC, and stages version, dependency-range,
and deterministic scratch-changelog overrides outside the checkout. It never
consumes or deletes a changeset. Source package manifests and changelogs are
snapshotted and compared byte-for-byte after packing. The scratch changelog is
bounded and contains only the fixed prerelease notice, source/package identity,
history, pending changeset identities, and the canonical notes URL. It has no
AI prose and does not replace the canonical stable changelog.

The `next` path preserves the full proof order. Independent attestation must
match the exact released SHA, plan digest, and every tarball digest. Clean
consumers cover every closure member. Changed adapters (the adapter members of
the closure) must each pass all five harness stages. Any missing, skipped, or
mismatched result stops the chain before approval and before OIDC. The protected
`prerelease` environment supplies the workflow-internal approval; npm trust
has no environment claim. Only `publish` has `id-token: write`, and it uses
npm's `next` dist-tag. Registry verification precedes create-once GitHub tags
and prerelease entries. The final notes artifact uses the deterministic wrapper
and raw pending-changeset identities. `latest` and the stable changelog never
move.

Reruns recompute authority and compare exact digests. Matching registry bytes,
tags, and prereleases are idempotent; conflicts fail closed. A `next` run does
not mutate Git source files or provide a Git mutation path for repair.

## The `nightly` channel

A maintainer-guarded `channel: nightly` route runs on the same trusted
workflow. The cutover moved the `17 0 * * *` schedule onto
`release-publish.yml`; it is the only schedule that workflow may declare, and
the reachability checker rejects any other cron.

The schedule stays inert until the rollout tuple reaches stage `ready` and mode
`enabled`. Until then the route job fails closed before any attestation,
proof, OIDC, or publish work.

The controller finds the latest successful nightly source SHA, computes the
affected-since-that-nightly package set, and closes it over shared changesets
and bundled-artifact dependencies. It never consumes or deletes changesets. An
empty set is a green `NothingToPublish` skip: no build, attestation, consumer or
harness proof, OIDC, registry verification, or Git refs run.

A non-empty run uses `<stable>-nightly.YYYYMMDD.sha12`. Version and dependency
changes are staging-only. Changelogs are deterministic scratch snapshots with
no AI or source mutation. Independent attestation and clean-consumer proof
cover every affected package. Minimum and latest host proofs cover every
affected adapter. Missing, skipped, or mismatched evidence blocks before OIDC.

`disabled` is a typed early exit. `dry-run` runs the full build, attestation,
consumer, and harness chain with publish and OIDC skipped. An eventual enabled
run uses the trusted workflow's `nightly` dist-tag, verifies registry digests,
and creates no Git tags or releases. Nightly has no approval environment.

## Rollout modes

The checked-in `rollout-stage.ts` declaration, the external mode, and the
workflow topology form one tuple:

- `disabled` exits before build, attestation, proof, OIDC, and publish;
- `dry-run` runs the chain and skips publish and OIDC;
- `ready` plus `enabled`, with the correct topology, is the only publication
  tuple.

Task 25 starts in `pre-cutover`. The old scheduled publisher remains separate
until the later cutover task. No schedule is added here. A frozen or
pre-cutover stage can never publish, even if an external variable says
`enabled`.

## Resume and artifact expiry

Dispatch the trusted workflow with `channel: stable-resume` and the merged
`released_sha`. The recomputed post-merge state selects the remaining Task 14
transitions. A fully published release with missing tags or releases runs only
the missing refs. A cleanup failure runs only the cleanup PR. A terminal release
with a leftover marker runs only safe marker cleanup after merged/closed proof.

Artifacts are cache, not authority. If an artifact expired:

- a published member is controlled by its immutable registry digest and
  provenance; rebuild it and require the complete proof chain before any
  repair;
- an unpublished member has no prior registry bytes, so a fresh binding must
  pass independent attestation, clean-consumer proof, and harness proof;
- a changed source or plan is a new candidate and cannot reuse the old binding.

Normal resume may not cross `IntegrityIncident`. It may clear only a safe
marker. This prevents a cached success from blessing unreproducible bytes.

## IntegrityIncident recovery

`IntegrityIncident` has one exit. An authorized maintainer dispatches the
`incident-resolution` channel and receives protected `release` environment
approval.

The first phase verifies immutable registry bytes and writes a bounded,
nonsecret authorization record. It emits exact shell-escaped `npm deprecate`
commands and stops with `IncidentDeprecationPending`. The maintainer runs those
commands interactively outside CI with npm login and MFA. CI never receives an
npm token and never executes the commands.

A later authorized dispatch reads each affected version's registry `deprecated`
field. Missing or mismatched text blocks completion. After exact readback, the
controller records the incident warning, safe tags/releases, check evidence,
and changeset cleanup, then the state becomes `CompleteWithIncident`.

The incident workflow never deprecates, publishes, unpublishes, or moves
`latest`. Do not replace immutable bytes. Fix forward from a new patch on
`main`; preserve the incident record and registry evidence.

## Reachability and permissions

`scripts/release/publish-reachability.ts` semantically walks every workflow,
local action, package production script and alias, and relative TypeScript
module edge. It rejects:

- a second workflow or script reaching `publish-main.ts`;
- a second entrypoint importing the publication executor;
- reusable-workflow indirection or `workflow_call` on the trusted or attest
  workflow;
- an extra or broadened permission, including an unlisted `id-token: write`;
- `npm deprecate`, direct `npm publish`, or production access to the local
  incident fixture or integration test.

The production entrypoint inventory is maintained with each executable root.
Tests and test globs remain test-only roots and do not authorize production
commands.

## Stable release PRs

`release-stable-prepare.yml` creates one stable PR and
`release-stable-regenerate.yml` updates it when `main` advances. The marker's
owner generation and compare-and-swap lease prevent two writers from replacing
one another. A failed creation cleanup is reported as `CreationCleanupPending`
and is recovered through authoritative doctor/resume checks. Do not manually
delete the marker or create a replacement PR.

## Pull-request docs audit

`.github/workflows/docs-audit.yml` is the only pull-request docs-audit trigger.
It uses `pull_request` (never `pull_request_target`) and filters public package
and adapter paths, the docs site, `docs/`, the root `README.md`, and
`.changeset/`. The deterministic job has no secrets and always runs. A
same-repository affected PR then runs the Task 19 isolated AI audit in the
protected `release-ai` environment. A fork receives no AI credential: its AI
feeder is a neutral skip with instructions to dispatch the follow-up.

The only required check is the terminal job and check named exactly
`docs-audit`. It runs with `if: always()` and reads the bounded feeder results
through `gate-main.ts` from protected `main`. No-impact input is a successful
not-required result. An affected same-repository PR needs a submitted AI
result. An affected fork needs a completed follow-up. Deterministic failure,
a hard finding, a missing/skipped/cancelled AI result, a pending or failed
follow-up, or a SHA mismatch fails the terminal check. Style findings remain
warnings. Feeder jobs are conditional and are never required directly.

### Fork follow-up

A maintainer dispatches **Docs audit follow-up** from
`.github/workflows/docs-audit-followup.yml` with a bounded pull-request number.
Every job checks out `refs/heads/main`; no job fetches a fork ref or checks out a
fork. `followup-main.ts` verifies that the PR base is `weave-io/weave` `main`
and the checked-out controller SHA. It downloads the head through the fixed
GitHub API route as bytes, validates the gzip/tar stream, rejects traversal,
symlink, hard-link, device, duplicate, and archive-bomb entries, and writes
only regular files below a separate runner-temp quarantine root. The fork tree
is never installed, imported, or used as a command or script tree. The Task 19
deterministic checker and isolated agent read only that data root.

The protected `release-app` job posts a check and comment that carry the head
SHA, controller SHA, archive digest, and result digest. The workflow then
reruns the terminal `docs-audit` check, so a follow-up converges the original
PR check instead of creating a second required name. A changed head or base
SHA requires a fresh dispatch.

Patch proposals use the separate `apply_patches` workflow-dispatch path and
explicit `docs-audit-patch` approval environment. The controller validates
proposals against the protected `main` tree and the docs/README allowlist
before opening a normal patch PR. The model never receives Git credentials or
a write tool.

## Validation

```bash
bun scripts/release/publish-reachability.ts
bun scripts/ci/verify-action-pins.ts
actionlint .github/workflows/release-publish.yml .github/workflows/release-attest.yml
bun run docs:check-links
```
