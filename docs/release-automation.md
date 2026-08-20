# Release automation architecture

Weave has one publication path: the trusted workflow
[`.github/workflows/release-publish.yml`](../.github/workflows/release-publish.yml).
It owns every `npm publish` for every channel, because npm permits exactly one
trusted-publisher configuration per package. The operator procedure lives in
[RELEASING.md](../RELEASING.md), the contributor view in
[Releases](contributing/releases.md), the one-time external setup in
[Release setup and rollout](contributing/release-setup.md), and the source
boundary in [`scripts/release/`](../scripts/release/).

## The acyclic publish chain

Publication is a fixed order, and every step gates the next:

```
build → bind → independent attest → clean-consumer proof
      → changed-adapter harness proof → environment approval
      → npm publish → registry digest verification → tags/releases → changeset cleanup
```

The bytes are built once and published unchanged. A binding record links the
released SHA, workflow SHA, run and attempt, server artifact IDs and digests,
the manifest, package versions, and file SHA-256s. Registry verification then
refetches the published tarball without credentials and compares its SHA-256
against the bound artifact, so no step trusts a workspace checkout or an
artifact name alone.

GitHub reports a run's `conclusion` as `null` until every job finishes, so
downstream jobs prove the completed origin `build` job through
`GET /actions/runs/{run_id}/jobs`, requiring that exact numeric job ID and
literal `build` name to have concluded `success`.

Artifact attestation lives in the separate, non-reusable
[`release-attest.yml`](../.github/workflows/release-attest.yml). Its filename
appears in no npm trust record, and it declares no `workflow_call` trigger, so
its OIDC identity can never publish. Inside `release-publish.yml`, only the
environment-gated `publish` job holds `id-token: write`.

## Channels

All four public packages ship on `stable` (`latest`), `next`, and `nightly`:

| Channel | Entry | Dist-tag |
| --- | --- | --- |
| stable | merged release PR, or `channel: stable-resume` dispatch | `latest` |
| next | `channel: next` dispatch | `next` |
| nightly | `channel: nightly` dispatch; scheduled at `17 0 * * *` once activated | `nightly` |

The publish job's npm CLI is the sole sanctioned exception to Weave's Bun-only
runtime rule, because npm >=11.5.1 is required for OIDC trusted publishing.

## The rollout gate

Publication is possible only when the checked-in rollout stage, the external
`RELEASE_ROLLOUT_MODE` variable, and the observed workflow topology agree. The
route job validates that tuple and fails closed before any attestation, proof,
OIDC, or publish work. The stage declaration is
[`scripts/release/rollout-stage.ts`](../scripts/release/rollout-stage.ts); the
runtime gate is
[`scripts/release/rollout-gate.ts`](../scripts/release/rollout-gate.ts).

The nightly `17 0 * * *` schedule lives on `release-publish.yml` but stays
inert until the stage is `ready` and the mode is `enabled`. The freeze and
activation procedure is documented in
[Release setup and rollout](contributing/release-setup.md).

## Immutability

Published versions and their tarballs are immutable. Dist-tags are mutable
pointers and never substitute for a version and digest proof. Weave accepts
the platform's attestation, GitHub Actions artifact identity, and npm
provenance rather than inventing a custom attestation or SBOM format; registry
tarball SHA-256 verification is the release-specific integrity check.

npm trusted publishing authorizes only the configured publish action, so
`npm deprecate` can never run under OIDC and no npm token may be added to
Actions. Every sanctioned deprecation is an authorized maintainer's interactive
npm session outside CI, with the exact commands generated beforehand and the
registry `deprecated` field verified afterward.

## Public boundary

The four published packages are `@weaveio/weave-cli`,
`@weaveio/weave-adapter-opencode`, `@weaveio/weave-adapter-claude-code`, and
`@weaveio/weave-adapter-pi`. Core, config, engine, and docs are private
bundled layers and are never published. Release PRs must link their related
issue.

Old npm preview versions and historical tags stay published: Weave never
unpublishes.

## History

An earlier system published through `publish.yml` using stable release trains,
a metadata-replay stage, and an interactive two-maintainer `npm dist-tag add`
promotion to `latest`. The cutover removed all of it, along with the
`release-refs-main` entrypoint and the standalone JSONL control binary. Nothing
in the current pipeline depends on those paths; read Git history for the
retired design.
