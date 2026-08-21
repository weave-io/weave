# Release security boundaries

This document is the static security sign-off for the Phase C release
workflows. The cutover removed the old `publish.yml` publisher, so they are now
the only release paths. It records
the credential, permission, execution, artifact, fork, and authentication
boundaries. The checked-in contract is enforced by
`scripts/release/publish-reachability.ts` and the action-pin checker.
A permission or credential change must update the checker, this table, and the
focused tests in `scripts/release/__tests__/publish-reachability.test.ts` in
the same change.

## Boundary rules

- The workflow root is default-deny (`permissions: {}`). A job receives only
the permissions in the tables below.
- `release-publish.yml#publish` is the only Phase C publication path. It is the
only job in that workflow with `id-token: write`.
- `release-attest.yml#attest` is an independent, non-reusable attestation path.
It has `id-token: write` for provenance and cannot reach `publish-main.ts`.
- `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` are protected credentials.
They exist only as environment secrets in `release-app`, `docs-audit-patch`,
and the retained legacy `release-refs` gate. Every job that needs App
authority runs the pinned
`actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1`
action, then passes only its short-lived output as
`RELEASE_APP_INSTALLATION_TOKEN` to the controller or `gh`. Installation
tokens expire after one hour and are never stored as secrets. Nightly has no
App environment and does not mint a token.
- `WEAVE_RELEASE_AI_API_KEY` is used only after `release-ai`. AI and harness
authentication uses API keys. CI does not receive npm tokens, npm
configuration credentials, OAuth tokens, refresh tokens, subscription
sessions, or persisted harness sessions.
- The workflow graph rejects `pull_request_target`, `npm deprecate`, direct
`npm publish`, fixture seams, and test-only release paths. It also rejects any
unlisted `id-token: write`.
- Every third-party action is pinned to a full commit SHA. The permanent
`bun run verify:action-pins` check allows only the approved `actions` and
`oven-sh` owners.

## Job, credential, and permission matrix

`none` means that the job has no stored credential. `github.token` is the
short-lived GitHub token supplied by Actions, not an App or npm credential.
Permissions are exact; omitted permissions are not inherited because the
workflow root is `{}`.

### `release-stable-prepare.yml` (Task 23)

| Job | Credential | Environment / gate | Exact `GITHUB_TOKEN` permissions |
| --- | --- | --- | --- |
| `authorize` | ephemeral `RELEASE_APP_INSTALLATION_TOKEN` | `release-app`; mint with `members: read` for Task 9 maintainer authorization | `contents: read` |
| `plan` | none | follows `authorize` | `contents: read`, `checks: read` |
| `docs-release-audit` | `WEAVE_RELEASE_AI_API_KEY` | `release-ai` | `contents: read` |
| `changelog-ai` | `WEAVE_RELEASE_AI_API_KEY` | `release-ai` | `contents: read` |
| `open-pr` | ephemeral `RELEASE_APP_INSTALLATION_TOKEN` | `release-app`; mint from protected App credentials, then marker ownership and creation gate | `contents: write`, `pull-requests: write`, `checks: read` |
| `plan-2` | none | only after `PreparationStale` | `contents: read`, `checks: read` |
| `docs-release-audit-2` | `WEAVE_RELEASE_AI_API_KEY` | `release-ai` | `contents: read` |
| `changelog-ai-2` | `WEAVE_RELEASE_AI_API_KEY` | `release-ai` | `contents: read` |
| `open-pr-2` | ephemeral `RELEASE_APP_INSTALLATION_TOKEN` | `release-app`; mint from protected App credentials, then retry ownership gate | `contents: write`, `pull-requests: write`, `checks: read` |
| `plan-3` | none | only after `PreparationStale` | `contents: read`, `checks: read` |
| `docs-release-audit-3` | `WEAVE_RELEASE_AI_API_KEY` | `release-ai` | `contents: read` |
| `changelog-ai-3` | `WEAVE_RELEASE_AI_API_KEY` | `release-ai` | `contents: read` |
| `open-pr-3` | ephemeral `RELEASE_APP_INSTALLATION_TOKEN` | `release-app`; mint from protected App credentials, then retry ownership gate | `contents: write`, `pull-requests: write`, `checks: read` |
| `recovery-summary` | none | failure summary only | `{}` |

All jobs check out `main` with `persist-credentials: false`. AI jobs run the
protected controller and receive no write permission.

### `release-stable-regenerate.yml` (Task 24)

| Job | Credential | Environment / gate | Exact `GITHUB_TOKEN` permissions |
| --- | --- | --- | --- |
| `manual-authorize` | ephemeral `RELEASE_APP_INSTALLATION_TOKEN` | `release-app`; mint with `members: read` for dispatch authorization | `contents: read` |
| `detect` | none | push or authorized dispatch detection | `contents: read`, `checks: read`, `pull-requests: read` |
| `plan` | none | protected `main` recomputation | `contents: read`, `checks: read` |
| `docs-release-audit` | `WEAVE_RELEASE_AI_API_KEY`, `github.token` for the check | `release-ai` | `contents: read`, `checks: write` |
| `changelog-ai` | `WEAVE_RELEASE_AI_API_KEY` | `release-ai` | `contents: read` |
| `update-pr` | ephemeral `RELEASE_APP_INSTALLATION_TOKEN` | `release-app`; mint from protected App credentials, then update ownership gate | `contents: write`, `pull-requests: write`, `checks: write` |
| `recovery-summary` | none | failure summary only | `{}` |

The automatic path is restricted to the checked-in `main` topology. The
manual path must pass the protected authorization job before it can detect or
update an open release PR.

### `release-publish.yml` (Tasks 25–27, 35)

| Job | Credential | Environment / gate | Exact `GITHUB_TOKEN` permissions |
| --- | --- | --- | --- |
| `route` | ephemeral `RELEASE_APP_INSTALLATION_TOKEN` for marker/API mutation | `release-app`, except `nightly`; mint with `contents: write` only after the gate | `contents: read`, `pull-requests: read` |
| `recompute` | none | protected `main`; source and plan authority | `contents: read`, `checks: read` |
| `build-bind` | none | exact recomputed source SHA | `contents: read`, `actions: write` |
| `await-attest` | `github.token` as `GH_TOKEN` for dispatch, polling, and checks | exact bound artifact | `contents: read`, `actions: write`, `checks: read` |
| `consumer-proof` | none | exact bound artifact | `contents: read`, `actions: read` |
| `harness-proof` | API-key credentials supplied to the proof port; never OAuth or a persisted session | `harness-proof`, except `nightly` | `contents: read`, `actions: read` |
| `release-approval` | none | `release` for stable/incident, `prerelease` for `next`, no environment for `nightly` | `contents: read`, `checks: read` |
| `publish` | OIDC only; no npm token, App token, AI key, or OAuth credential | `release` for stable/incident, `prerelease` for `next`, no environment for `nightly`; rollout must be enabled | `actions: write`, `contents: read`, `id-token: write` |
| `registry-verification` | none | after publication | `contents: read`, `actions: read` |
| `refs-cleanup` | ephemeral `RELEASE_APP_INSTALLATION_TOKEN` | `release-app`, skipped for `nightly`; mint after the gate | `contents: write`, `pull-requests: write` |

The Phase C checker compares every job above, including omitted permissions,
to the checked-in contract. `publish` invokes only
`scripts/release/publish-main.ts`; the command is reached only after the
artifact, attestation, consumer, harness, approval, and rollout gates.

The `release-refs` environment supports the refs and cleanup boundary. It
must keep the same `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` metadata as
`release-app` and `docs-audit-patch`. The checker and doctor both require this
duplicate environment-secret contract; they do not weaken it to
repository-wide secrets.

### `release-attest.yml` (Task 25)

| Job | Credential | Environment / gate | Exact `GITHUB_TOKEN` permissions |
| --- | --- | --- | --- |
| `attest` | `github.token` for the numeric artifact and check; OIDC for provenance | independent `workflow_dispatch`; exact source/run/artifact/digest identities | `contents: read`, `actions: read`, `checks: write`, `id-token: write`, `attestations: write` |

This workflow is top-level and non-reusable. It validates the checked-out SHA,
plan digest, and every tarball digest before the attestation action. It never
runs the publication entrypoint.

### `docs-audit.yml` (Task 30)

| Job | Credential | Environment / gate | Exact `GITHUB_TOKEN` permissions |
| --- | --- | --- | --- |
| `docs-deterministic` | none | every eligible `pull_request`; PR content is untrusted input | `contents: read` |
| `docs-ai-audit` | `WEAVE_RELEASE_AI_API_KEY` | same-repository PR only; `release-ai` | `contents: read` |
| `docs-ai-fork-skip` | none | fork PR neutral skip | `{}` |
| `docs-audit` | `github.token` for the terminal check | protected `main`; `if: always()` | `contents: read`, `checks: write` |

Fork content never receives a secret, is never checked out, installed, or
imported, and is never used as a command tree. The deterministic job and the
terminal gate remain safe for fork events.

### `docs-audit-followup.yml` (Task 30)

| Job | Credential | Environment / gate | Exact `GITHUB_TOKEN` permissions |
| --- | --- | --- | --- |
| `followup-audit` | `github.token` for bounded PR reads; `WEAVE_RELEASE_AI_API_KEY` | `release-ai`; maintainer-dispatched PR number | `contents: read`, `pull-requests: read` |
| `followup-post` | ephemeral `RELEASE_APP_INSTALLATION_TOKEN` | `release-app`; mint, then post the digest-bound result | `contents: read`, `pull-requests: write`, `checks: write` |
| `docs-audit` | ephemeral `RELEASE_APP_INSTALLATION_TOKEN` | `release-app`; mint, then rerun the terminal check | `contents: read`, `checks: write` |
| `apply-patches` | ephemeral `RELEASE_APP_INSTALLATION_TOKEN` as `GH_TOKEN` and controller input | `docs-audit-patch`; mint after the explicit boolean and approval gate | `contents: write`, `pull-requests: write` |

`followup-main.ts` downloads a fork as bounded regular-file data below a
separate quarantine root. It validates the repository, base branch, archive,
paths, and digest. It never installs, imports, or executes the fork. Patch
application accepts only the validated docs allowlist and opens a normal PR.

## Every `release-publish.yml` channel path

| Channel path | Route and authorization | Artifact / proof path | Publish and cleanup result |
| --- | --- | --- | --- |
| Stable PR close (`pull_request` closed on `main`) | `route` validates the merged/closed PR, protected `main`, marker cleanup, and rollout topology; `release-app` gates mutation | `recompute → build-bind → await-attest → consumer-proof → harness-proof → release-approval` | `release` approval, OIDC `publish`, registry verification, then App-token refs/cleanup |
| Stable resume (`workflow_dispatch`, `channel=stable-resume`) | `route` requires maintainer authorization and the bounded `released_sha`; `recompute` rereads protected `main` authority | Same complete proof chain from the recomputed source; no stale artifact is authority | `release` approval, OIDC publish only when the rollout is enabled, then registry/ref recovery |
| Incident resolution (`workflow_dispatch`, `channel=incident-resolution`) | `route` requires maintainer authorization; `release-approval` is the exact protected incident boundary | Recompute and proof jobs run before approval; the incident carrier is read only after `release` approval | `publish` is skipped; no OIDC publication; incident completion may proceed through its explicit controller, while normal cleanup remains closed |
| Next (`workflow_dispatch`, `channel=next`) | `route` requires maintainer authorization and bounded package booleans | Full build, independent attestation, clean consumers, and changed-adapter harness proof | `prerelease` approval, OIDC publish with the `next` tag, registry verification, and create-once prerelease refs |
| Nightly (`workflow_dispatch`, `channel=nightly`, or protected `schedule`) | `route` validates the exact nightly event on protected `main` and has no approval environment | A `NothingToPublish` plan stops before build and every proof. A non-empty plan uses the complete proof chain | No `release`/`prerelease` environment and no refs cleanup; enabled runs publish with the nightly tag and verify the registry |

The `publish` job is skipped for disabled or dry-run rollout modes and for
incident resolution. A nightly empty plan is a typed, successful no-op, not an
authorization to publish.

## Input and artifact boundaries

Workflow values are untrusted until a controller validates them. Release
invocation identity, event, ref, operation, channel, package set, and bounded
versions use the strict schemas in `scripts/release/input-validation.ts`.
Control environment identity and artifact-binding CLI values use the same
module. Controllers validate before interpolation, API calls, artifact reads,
or side effects. The input limits bound package counts, artifact counts,
manifest sizes, and identifier lengths.

Every artifact boundary revalidates identity and bytes. The build binding
checks the source SHA, plan digest, package catalog, tarball digests, and
bounded manifests. Download consumers use the numeric artifact/run identity
and then validate the downloaded plan, proof, and tarball bindings. The
attestation path independently recomputes the plan and tarball digests.
`consumer-proof-main.ts`, `harness-proof-main.ts`, `await-attest-main.ts`,
`attest-main.ts`, and the docs-audit gate reject missing, malformed, foreign,
truncated, or mismatched records. Artifacts are cache; protected `main`, the
registry, and digest-bound checks remain authority.

Fork data is data-only. The follow-up archive is bounded before extraction and
is confined to a separate regular-file tree. No fork package script,
`package.json`, dependency tree, workflow, or source module is executed by a
trusted job.

## Authentication and execution inventory

The only permitted `id-token: write` identities are:

1. `.github/workflows/release-publish.yml#publish`;
2. `.github/workflows/release-attest.yml#attest`; and
3. the explicitly named, unrelated identity
   `.github/workflows/deploy-docs.yml`.

The third entry is a narrow allowlist for Pages deployment, not a release
path. It is not a wildcard. The cutover removed the old publisher's identity
from this inventory. `lintWorkflowPermissions` rejects every other root or job
identity and checks the exact attestation permissions.

`scanCredentialSources` rejects npm auth environment variables, npm config
auth, credential helpers, keychains, and auth-bearing config files before
publication. `validateProofCredentials` accepts only named `api-key`
credentials. The workflow security lint rejects npm token/config names,
OAuth/subscription/refresh/session names, and non-API-key AI or harness
credentials. Data-only shell guards do not provide credentials and remain
allowed. The App
installation contract is Contents: write, Pull requests: write, Checks: write
when a check mutation needs it, and Members: read for organization/team
authorization. Each mint step requests only the permissions used by that job.

All workflow action references are full SHAs and are checked by
`scripts/ci/verify-action-pins.ts`. No CI workflow uses `pull_request_target`.
The semantic reachability check scans workflow commands, local actions, package
aliases, and production module edges. It permanently asserts Task 25's single
`publish-main.ts` path and fails on `npm deprecate` or any direct `npm publish`
path.

## Mechanical checks

Run the focused boundary checks from the repository root:

```bash
bun test scripts/release/__tests__/publish-reachability.test.ts
bun test scripts/release/__tests__/input-validation.test.ts
bun test scripts/release/__tests__/harness-proof.test.ts
bun scripts/release/publish-reachability.ts
bun run verify:action-pins
bun run docs:check-links
```

The normal CI workflow runs the reachability tests, action-pin verification,
typecheck, lint, and documentation-link checks. A permission, credential,
OIDC, action-reference, fork-execution, or publication-entrypoint change must
fail one of these checks before merge.

## Sign-off evidence

The repository-side static review is recorded by this document, the exact
Phase C contract, and the focused regression tests. External sign-off still
requires a maintainer comment on release issue `#143` confirming the seven
GitHub environment protection rules (`release-app`, `release-ai`, `release`,
`prerelease`, `harness-proof`, `docs-audit-patch`, and `release-refs`), their
required reviewers, the duplicate App credential metadata in the three App
environments, and the current unrelated OIDC allowlist. If repository/API access
is unavailable, attach the GitHub Actions environment settings and the
maintainer authorization audit as the external evidence; do not treat this
static review as proof of those GitHub-side settings.
