# Release setup and rollout

This page defines the setup that the release doctor verifies. The doctor is
read-only. It does not create environments, secrets, npm trust records, refs,
or GitHub rules.

Run the doctor from a clean checkout of protected `main`:

```sh
bun run release:doctor --pre-cutover
```

The command prints grouped pass, warning, and failure checks. A failure
includes the manual fix. An unknown or unreadable value fails closed.

Before the first pre-cutover doctor run, prove the retained publisher with the
explicit read-only operation from protected `main`:

```sh
gh workflow run publish.yml --repo weave-io/weave --ref main -f operation=preflight
run_id="$(gh run list --repo weave-io/weave --workflow publish.yml --branch main --event workflow_dispatch --limit 20 --json databaseId,displayTitle --jq '.[] | select(.displayTitle == "legacy-publisher-preflight") | .databaseId' | head -n 1)"
test -n "$run_id"
gh run watch "$run_id" --repo weave-io/weave --exit-status
gh run view "$run_id" --repo weave-io/weave --json databaseId,displayTitle,status,conclusion,event,headBranch,headSha,workflowName,workflowRef
```

Capture the final `gh run view` JSON with the doctor evidence. It must show
`displayTitle` `legacy-publisher-preflight`, `conclusion` `success`, event
`workflow_dispatch`, `headBranch` `main`, the protected-main `headSha`, and
workflow ref `weave-io/weave/.github/workflows/publish.yml@refs/heads/main`.
The run summary must state publication enablement `true`, read-only `true`, and
side effects `none`. Do not use a normal `workflow_dispatch` operation as a
substitute. The preflight does not install dependencies, query npm, mint OIDC
or App credentials, publish packages, or mutate refs.

### Workflow-run identity contract

The doctor reads GitHub's [list workflow runs for a workflow](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow)
response, scoped to `publish.yml` and protected `main`. The matching
[official OpenAPI example](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json)
uses the same `Workflow Run` shape. GitHub's documented response schema
requires the run ID, workflow `path`, `head_branch`, `event`,
`conclusion`, `created_at`, `updated_at`, `repository`,
`head_repository`, and `display_title`. The repository objects must contain
`full_name`. GitHub permits `name` to be null in the schema, so the doctor
rejects a null or missing name instead of treating it as an identified
`Publish control plane` run. `run_started_at` is optional; the doctor uses the
required `updated_at` timestamp for the 90-day bound.

The accepted workflow path is the exact old path
`.github/workflows/publish.yml`. The API's documented examples also show the
same path with an exact `@main` suffix, so the doctor accepts only that known
form (including the documented repository-qualified form), never a missing or
other path. `workflow_ref` is not part of the list-runs response schema and is
therefore not required; if an enriched response supplies it, it must still
match `weave-io/weave/.github/workflows/publish.yml@refs/heads/main`.

A scheduled success is accepted only with the exact workflow name, repository
and head-repository identity, protected `main`, successful conclusion, valid
ID and timestamps, and `event: schedule`. A dispatch is accepted only when
those fields also identify `event: workflow_dispatch` and
`display_title: legacy-publisher-preflight`. Missing or malformed identity
fields fail closed.

## Manual setup

Complete these steps in GitHub and npm. Do not put credential values in a
workflow log, a doctor fixture, or a report.

### GitHub environments

Create these repository environments in **Settings → Environments**:

- `release` — protects stable publication and incident recovery.
- `prerelease` — protects `next` and nightly proof work.

Configure the required reviewers and wait for GitHub to save the protection
rules. The doctor checks that both environments exist, that their metadata is
readable, and that GitHub reports a `required_reviewers` protection rule that
names at least one reviewer. An environment that exists with no protection
rules — GitHub returns an empty object or an empty rule list — gates nothing
and fails the doctor. The doctor does not check or print secret values.

### Ruleset and required checks

In **Settings → Rules → Rulesets**, apply one ruleset to `main`. Configure the
required checks as this exact set:

- `ci`
- `release-policy`
- `api-reports`
- `docs-audit`

`docs-audit` is the stable terminal check. Do not make conditional feeder jobs
such as `docs-ai-audit` or the fork follow-up required directly. These four
names are the complete required-check set; conditional feeder jobs are never
required on their own.

Enable **Require a pull request → Dismiss stale pull request approvals when new
commits are pushed**. This setting is part of the release safety contract. A
ruleset with the right check names but without stale-approval dismissal fails
the doctor. Stale-approval dismissal complements the `release-policy`
freshness check: dismissal invalidates an approval after any new commit, while
freshness rejects a release plan whose `baseSha` is no longer current `main`.
Both controls are required.

### Release GitHub App and team

Install the release GitHub App on `weave-io/weave`. Its installation must
have the following contract:

- **Contents: write**
- **Pull requests: write**
- **Checks: write** when a release or docs job updates a check
- **Members: read** for organization/team maintainer authorization

Each workflow job requests only the permissions that it uses when it mints an
installation token. Create or retain the `weave-io/release-maintainers` team.
The team is the authorization source for stable release requests. The doctor
requires that GitHub can read the team and its membership.

### Protected App credentials and secret names

Create these exact names as environment secrets. Do not create App credentials
at repository scope:

- `release-app`: `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`
- `docs-audit-patch`: `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`
- `release-refs`: `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY` for retained
  legacy `publish.yml`
- `release-ai`: `WEAVE_RELEASE_AI_API_KEY`

The App ID and private key are protected credentials. Every App-authority job
runs the pinned official `actions/create-github-app-token` action and passes
only its output to the controller or `gh` step as the ephemeral
`RELEASE_APP_INSTALLATION_TOKEN`. GitHub App installation tokens expire after
one hour. Never store that token as a secret or create an installation-token
secret name.

The doctor verifies names and environment placement only. It never reads,
prints, or writes a secret value. Code cannot set secrets. A maintainer must
create them in **Settings → Secrets and variables → Actions** and configure
the required reviewers on all three App environments.

Harness proof credentials belong only to the proof job's protected environment.
They must not be passed to the npm publication job. Never add `NPM_TOKEN`,
`NODE_AUTH_TOKEN`, or another long-lived npm token to Actions.

## npm ownership and trusted publishing

Each public package must belong to the `weave-io` release owner and expose a
readable `latest` dist-tag after it is published. Published bytes are
immutable. Never unpublish a package or move `latest` backward from CI.

The doctor runs the authoritative npm query for every package:

```sh
npm trust list <package> --json
```

There is no manual-inspection fallback for this check. The response must parse
and contain exactly one configuration when the selected rung expects trust.
That configuration must have:

- workflow exactly `.github/workflows/release-publish.yml` at the new-pipeline
  rungs;
- action exactly `npm publish`;
- repository exactly `weave-io/weave`;
- no environment restriction.

`release-attest.yml` must appear in no npm trust record. It is an independent
attestation workflow, not a publisher.

## Executable mode ladder

Run these modes in order. Each mode checks the complete tuple of the checked-in
stage, `RELEASE_ROLLOUT_MODE`, and observed workflow topology. A mode does not
accept a neighboring rung.

| Order | Command | Required tuple | Typed result | Operational step |
| --- | --- | --- | --- | --- |
| 1 | `bun run release:doctor --pre-cutover` | stage `pre-cutover`; mode `disabled` or `dry-run`; old `publish.yml` scheduled and the new workflow scheduleless | `ReadyForCutover` | Task 32 preflight. CLI/OpenCode still trust old `publish.yml`; Claude/Pi remain unpublished. |
| 2 | `bun run release:doctor --cutover` | stage `frozen`; mode `disabled`; old workflow absent; new `release-publish.yml` has the `17 0 * * *` schedule; valid freeze record | `CutoverVerified` | Task 35 freeze and cutover. CLI/OpenCode trust switches during the freeze. |
| 3 | `bun run release:doctor --post-bootstrap-frozen` | stage `frozen`; mode `disabled`; valid freeze record; all four packages trust the new workflow | `ReadyForActivation` | Task 38 post-bootstrap readiness. Claude/Pi trust is added by the approved bootstrap step. This is not final health. |
| 4 | `bun run release:doctor --activation-ready` | stage `ready`; mode `disabled`; valid freeze and activation records; all four trust the new workflow | `ActivationReadyVerified` | Task 38 reviewed activation commit. Publication is still disabled. |
| 5 | `bun run release:doctor` | stage `ready`; mode `enabled`; valid records; all four trust the new workflow | `FinalVerified` | Task 38's single external variable flip. This is the only normal publishing tuple. |

The stage declaration lives in
[`scripts/release/rollout-stage.ts`](../../scripts/release/rollout-stage.ts).
The initial checked-in stage is `pre-cutover` with no freeze or activation
record. A freeze record carries a commit, timestamp, and quiescence evidence.
An activation record carries a reviewed commit, timestamp, and the green
`--post-bootstrap-frozen` report link.

Do not set `RELEASE_ROLLOUT_MODE=enabled` while the stage is `pre-cutover` or
`frozen`. Do not set it before the reviewed stage-to-`ready` commit. If the
variable flip fails, leave the system at `ready` + `disabled` and rerun
`--activation-ready`; no second code change is needed.

## Recovery checks

The doctor also reads Task 14's recomputed post-merge state and the
`release-pr/stable` marker.

- `PendingArtifactsOrProof`, `PendingNpm`, `PendingRegistryVerification`,
  `PendingTagsOrReleases`, and `PendingChangesetCleanup` recover with
  `gh workflow run release-publish.yml --ref main -f channel=stable-resume`.
- A marker with a merged or closed release PR is `MarkerCleanupPending`. Resume
  clears it only after authoritative merged/closed proof. The doctor never
  deletes the ref.
- A marker with no open PR is reported as stalled creation or
  `CreationCleanupPending`. Resume performs bounded reconciliation and a
  generation-verified CAS cleanup. A stale cleanup generation never deletes a
  successor's marker.
- `IntegrityIncident` never crosses through normal resume. Use the protected
  `incident-resolution` dispatch. The protected operation verifies immutable
  registry bytes, emits an authorization record and exact commands, and stops.
  A maintainer runs those `npm deprecate` commands interactively with npm
  login/2FA. Afterward, rerun the protected dispatch; completion requires an
  exact registry `deprecated` readback. CI never runs `npm deprecate`, unpublishes,
  or moves `latest`.
- `CompleteWithIncident` is terminal and allows fix-forward preparation after
  the durable warning, refs, cleanup, and deprecation readback are authoritative.

### Where post-merge authority comes from

The doctor recomputes Task 14 state from immutable, source-bound observations.
It never reads a pull-request comment, and it never treats a workflow artifact
as authority.

| Authority | Source |
| --- | --- |
| Package identity and version | `package.json` at the release merge commit |
| Publication, bytes, deprecation | the npm registry version document and tarball |
| Expected digest | npm's published provenance statement, accepted only when its in-toto subject is the served tarball and its build source commit is the released commit |
| Tags and releases | Git tag refs and GitHub releases |
| Changeset cleanup | the merged tree plus `main`'s tree, so a cleanup pull request merged *after* the release is observed |
| Artifact cache and independent proof | Actions runs for `release-publish.yml` and `release-attest.yml` at the released commit |
| Integrity-incident authorization | the protected `release-integrity-incident` check run on the released commit |
| `CreationCleanupPending` | Weave's durable release-state database |

When npm has published no provenance for a version, that is an observed
`PendingRegistryVerification`. When npm has published provenance that does not
describe the served bytes or names another commit, the doctor fails closed:
only the protected incident-resolution operation records the attested digest of
foreign bytes, and the doctor never invents one.

### Durable release-state database

`CreationCleanupPending` is operational state, so it is read from Weave's
durable database rather than from a comment or an artifact. The doctor opens
the database read-only and never creates, migrates, or writes it.

- `WEAVE_RELEASE_STATE_DB` selects the database explicitly. A named database
  that does not exist fails the doctor.
- Without that variable the doctor reads
  `$XDG_DATA_HOME/weave/release-state.sqlite`, defaulting to
  `~/.local/share/weave/release-state.sqlite`. A missing default file is the
  store's empty state.

The record is bound to its generation and its pull request. A record that
survives while a stable release pull request is associated with the live
marker, or that names a pull request which is not an authoritative stable
release PR, fails the doctor.

### Outbound read boundaries

Every outbound doctor read is bounded. HTTP reads have a wall-clock timeout and
a byte bound counted while the body streams; `npm` subprocesses have a
wall-clock timeout and stdout/stderr byte bounds counted while the streams
drain. The GitHub credential is attached only after the API origin is proven to
be `https://api.github.com`; a `GITHUB_API_URL` naming another host, scheme,
port, userinfo, path, query, or fragment is refused rather than normalized.

A green doctor report is evidence for the selected rung only. It is not a
replacement for the reviewed freeze, activation commit, or protected GitHub
approval.
