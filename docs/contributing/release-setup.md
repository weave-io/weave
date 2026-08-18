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

## Manual setup

Complete these steps in GitHub and npm. Do not put credential values in a
workflow log, a doctor fixture, or a report.

### GitHub environments

Create these repository environments in **Settings → Environments**:

- `release` — protects stable publication and incident recovery.
- `prerelease` — protects `next` and nightly proof work.

Configure the required reviewers and wait for GitHub to save the protection
rules. The doctor checks that both environments exist and that their metadata
is readable. The doctor does not check or print secret values.

### Ruleset and required checks

In **Settings → Rules → Rulesets**, apply one ruleset to `main`. Configure the
required checks as this exact set:

- `ci`
- `release-policy`
- `api-reports`
- `docs-audit`

`docs-audit` is the stable terminal check. Do not make conditional feeder jobs
such as `docs-ai-audit` required directly.

Enable **Require a pull request → Dismiss stale pull request approvals when new
commits are pushed**. This setting is part of the release safety contract. A
ruleset with the right check names but without stale-approval dismissal fails
the doctor.

### Release GitHub App and team

Install the release GitHub App on `weave-io/weave`. Its installation must have
at least:

- **Contents: write**
- **Pull requests: write**

Create or retain the `weave-io/release-maintainers` team. The team is the
authorization source for stable release requests. The doctor requires that
GitHub can read the team and its membership.

### Secret names

Create the required secret names in the repository or the environment where
the workflow contract places them:

- `RELEASE_APP_TOKEN`
- `WEAVE_RELEASE_AI_API_KEY`

The doctor verifies names only. It never reads, prints, or writes a secret
value. Code cannot set secrets. A maintainer must create them in **Settings →
Secrets and variables → Actions**.

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

A green doctor report is evidence for the selected rung only. It is not a
replacement for the reviewed freeze, activation commit, or protected GitHub
approval.
