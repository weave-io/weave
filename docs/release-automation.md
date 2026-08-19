# Release automation architecture

Weave uses an artifact-first release pipeline: protected control code builds
public tarballs, records an artifact manifest, binds that manifest to immutable
GitHub Actions artifact metadata, and only then publishes. See the stable-train
operator procedure in [RELEASING.md](../RELEASING.md) and the source boundary in
[`scripts/release/`](../scripts/release/).

## Identity and artifacts

GitHub reports a workflow run's `conclusion` as `null` until all of its jobs
finish. Downstream release jobs therefore prove the completed origin `build`
job via `GET /actions/runs/{run_id}/jobs`. A binding records the numeric job ID
and literal `build` name, then requires that exact job's conclusion to be
`success`. This preserves live-run verification without weakening the existing
repository, run/attempt, event, workflow path/SHA, subject SHA, artifact ID,
and digest checks.

The release-control binary runs in an isolated clean room. A binding record
links the release subject SHA, protected workflow SHA, workflow run, server
artifact IDs/digests, manifest, package versions, and file SHA-256s. The
registry verification then fetches the public tarball without credentials and
checks its SHA-256 against the bound artifact. This avoids trusting a workspace
checkout or an artifact name alone.

## OIDC trust chain and channels

GitHub's release environment approves the OIDC identity used for npm trusted
publishing. The workflow denies credential sources and has no npm token. Nightly
versions publish to `nightly`; stable-train CLI and OpenCode versions first
publish to `next`. A successful stable publish emits an authorization record
with the exact subject, versions, and digests.

The publish job's npm CLI is the sole sanctioned exception to Weave's Bun-only
runtime rule because npm >=11.5.1 is required for OIDC trusted publishing.

`latest` is intentionally different. npm trusted publishing currently cannot
run `npm dist-tag add` ([npm/cli#8547](https://github.com/npm/cli/issues/8547)).
Fully automatic tokenless promotion is therefore impossible today. The workflow
never contains a dist-tag mutation and the command runner only permits
read-only `npm dist-tag ls`; a second maintainer uses MFA interactively after
the authorization and both `next` tarballs are reverified. A read-only
`stable-finalize` job proves both `latest` tags and tarball digests before later
App release work may run.

If policy removes the interactive exception, stable promotion must be disabled
until npm adds supported trusted-publisher dist-tag mutation and Weave retests
the complete flow. An automation token is not an acceptable substitute.

## Immutability and attestations

Published versions and their tarballs are immutable. Dist-tags are mutable
pointers and never substitute for a version/digest proof. We accept the
platform's immutable-release attestation, GitHub Actions artifact identity, and
npm provenance path; Weave does not invent a custom attestation or SBOM format.
Registry tarball SHA-256
verification is the release-specific integrity check.

## Public boundary and external setup

Sanitized public packs are CLI and OpenCode for stable/nightly trains plus the
nightly standalone Claude adapter. Core, config, and engine are bundled private
layers. Configure trusted publishing for `weave-io/weave` `publish.yml`, protect
`main` and release environments, and use no npm automation token. Release PRs
must link their related issue. `preview` is retired; historical versions remain
published under the no-unpublish policy.

## Stable-train state machine

`scripts/release/stable-train.ts` is the executable source of truth. Every state
record is content-addressed; a transition creates a new digest.

```mermaid
stateDiagram-v2
  prepared --> built --> bound --> published-next --> awaiting-promotion --> promoted
  published-next --> partial
  awaiting-promotion --> partial
  promoted --> release-draft --> finalized --> metadata-pending
  metadata-pending --> finalized
  prepared --> abandoned
  built --> abandoned
  bound --> abandoned
  release-draft --> abandoned
  partial --> abandoned
  expired --> abandoned
```

| State | Legal next states |
| --- | --- |
| prepared | built, blocked, abandoned, expired |
| built | bound, blocked, abandoned, expired |
| bound | published-next, blocked, abandoned, expired |
| published-next | awaiting-promotion, partial, blocked, expired |
| awaiting-promotion | promoted, partial, blocked, expired |
| promoted | release-draft, finalized, metadata-pending, blocked |
| release-draft | finalized, metadata-pending, blocked, abandoned |
| finalized | metadata-pending |
| metadata-pending | finalized, blocked |
| blocked | abandoned, expired |
| expired | abandoned |
| abandoned | none |
| partial | blocked, abandoned |

Expiry forbids publish, finalize, and fix. Before publication, abandonment is
clean. A partial publish is terminal for promotion: recovery metadata records its
used versions and mandates a fresh-main cut, whose version derivation skips those
reservations. Rebuilds, reruns, and fixes discard old artifact IDs/digests. A
metadata collision transitions to `blocked` and trains remain serialized until
the metadata replay PR merges; only then may its `release/*` branch be cleaned.
After stable promotion, fix forward on `main` and cut anew. Emergency rollback
can restore npm dist-tags interactively, but never changes npm versions, GitHub
tags/releases, or attestations.

### Manual promotion and cross-run finalization

`stable-publish` emits an identity-bound promotion authorization plus exact
version-pinned promotion and rollback commands. The standalone, checksum-verified
control binary reads each prior `latest` value after `next` publication and embeds
the command text in its JSON output. The clean-room workflow only extracts and
displays this trusted output; it neither installs Bun nor executes workspace code
or a dist-tag command.

`stable-finalize` is deliberately a later dispatch and does not rebuild. The
`release-refs` job downloads the numeric payload artifact ID from the originating
run using the authorization-bound run ID. It validates the payload manifest, but
validates the `awaiting-promotion → promoted` lineage against the dispatch train
that is cryptographically tied to the authorization—not the payload's pre-bind
train. This preserves the original artifact retrieval identity without allowing a
free-form run ID or a substituted train to advance release refs.
