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
job in the trusted workflow has `id-token: write`, and it has no App token. It
invokes the existing `publish-main.ts` entrypoint. The App-token `refs-cleanup`
job runs only after every registry digest is verified. It creates tags and
releases without updating an existing conflicting ref, then opens the
changeset-cleanup PR.

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

## Validation

```bash
bun scripts/release/publish-reachability.ts
bun scripts/ci/verify-action-pins.ts
actionlint .github/workflows/release-publish.yml .github/workflows/release-attest.yml
bun run docs:check-links
```
