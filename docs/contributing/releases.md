# Releases

Weave uses an artifact-first release pipeline. Protected control code builds public tarballs, binds their identities and digests to a release record, then publishes through npm trusted publishing.

The operator procedure lives in [`RELEASING.md`](../../RELEASING.md). Executable policy lives in [`scripts/release/`](../../scripts/release). This page explains the invariants contributors must preserve.

---

## Public packages

Stable and nightly trains publish the CLI and OpenCode adapter. Standalone Claude Code and Pi adapters are nightly unless the release policy explicitly promotes them. Core, config, and engine remain bundled internal layers rather than consumer npm dependencies.

Published versions are immutable and are never unpublished. Dist-tags are mutable pointers, never proof of artifact identity.

## Artifact identity

A release binding ties together:

- release subject SHA;
- protected workflow SHA and path;
- GitHub run, attempt, and completed `build` job identity;
- server artifact IDs and digests;
- package versions;
- tarball paths and SHA-256 values;
- the release manifest.

The control binary runs in a clean room. Before and after treating a checkout as input, callers verify that `git status --porcelain` is empty. Registry verification fetches public versioned tarballs without credentials and compares their hashes with the bound artifacts.

## Channels

- `nightly` receives nightly builds.
- `next` receives a stable train before promotion.
- `latest` changes only after a second maintainer verifies both `next` tarballs and performs the MFA-protected promotion.

npm trusted publishing cannot currently run `npm dist-tag add`, so tokenless automatic `latest` promotion is unavailable. Do not replace this control with a long-lived npm automation token.

The npm CLI used for OIDC publication is the one approved exception to the Bun-only runtime rule.

## Stable train

A stable cut starts at a green protected `main` SHA and uses GitHub server time as `cutAt`. The train expires at `cutAt + 7 days`; the boundary is exclusive.

Its content-addressed record holds the release ref, deterministic versions, consumed stable Changesets with preimage digests, preserved post-cut or Claude-only Changesets, and metadata writes needed for replay.

Only packages in the stable public boundary and stable-partition Changesets enter the worktree plan.

## State machine

[`scripts/release/stable-train.ts`](../../scripts/release/stable-train.ts) is the source of truth for states and legal transitions. Every transition creates a new content-addressed record.

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
  partial --> abandoned
  expired --> abandoned
```

Expiry forbids publish, finalize, and fix. A partial publish cannot be promoted; recovery reserves used versions and starts a fresh cut from green `main`. Published artifacts are never replaced.

## Fixes and concurrency

`stable-fix` accepts only explicit green commits proved merged to `main`. It never merges `main` into a train. Release-ref mutation uses read-current-head plus ordinary non-force update; a changed head is a typed stale-CAS failure.

A fix invalidates prior artifact IDs and manifest binding. The new release SHA must rebuild and bind fresh artifacts before any OIDC action.

Trains remain serialized until required metadata replay merges. After promotion, fix forward on `main` and cut a new train.

## Trust boundaries

- The `release` environment authorizes plan generation and OIDC publication.
- The separate `release-refs` environment owns the GitHub App token for ref mutation.
- Workflows contain no npm token.
- The clean-room job does not execute untrusted workspace code for manual promotion.
- Release pull requests reference their related issue.

The pipeline accepts GitHub artifact identity, npm provenance, and platform immutable-release attestations. It does not invent a separate attestation or SBOM format.

## Pi acceptance assets

Machine-consumed Pi acceptance files live under [`scripts/release/pi-acceptance/`](../../scripts/release/pi-acceptance), not in documentation. Generation and validation scripts own their format. Human documentation may link to them but must not duplicate their requirement rows.
