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

## Stable release PR

The only maintainer-request entry point is
`.github/workflows/release-stable-prepare.yml`. A dispatch has four exact
package booleans (`cli`, `opencode`, `claude-code`, and `pi`) and a `thinking`
choice whose default is `medium`. At least one package must be selected. The
workflow rejects the request before closure calculation or model work when the
selection is empty, the actor is not in the `release-maintainer` team, `main` is
not green, an open stable release PR already exists, or the recomputed merged
release is not terminal. `CompleteWithIncident` is terminal and allows
fix-forward. A second request is not a regeneration and never silently edits the
existing PR.

The plan records the exact green `plannedBaseSha`, selection closure, consumed
Changeset identities, versions, and evidence. The deterministic docs checker,
conditional docs AI, and shared Task 19 gate all use that SHA. Style findings
are warnings; deterministic failures, missing/skipped/cancelled required AI,
and hard findings are terminal failures. The gate runs again for every stale-head
replan. The final release PR carries the docs-audit metadata with
`auditedSha === baseSha`.

Task 9 owns the marker race, ownership generation, finalization, and cleanup.
There is no shared release-PR concurrency group: every explicit request reaches
a typed result. A losing marker race polls for and reports `ReleasePrExists` with
the visible URL. A `PreparationStale` result triggers a statically bounded
`plan → docs-release-audit → changelog-ai → open-pr` sequence. The replan
recomputes the closure and evidence and applies the prose reuse rule: reuse is
allowed only for unchanged Changeset identity sets; unseen Changesets require
fresh prose. The workflow never calls `regenerate` and never runs `npm publish`.

Every failure after marker ownership uses `abortOwnedCreation`. A visible PR
keeps the marker. A proven absent PR permits only an owned-marker CAS delete.
An ABA successor marker is never deleted by an older run. An unverifiable cleanup
returns `CreationCleanupPending` with the doctor/resume recovery link. Exhausted
freshness returns retryable `PreparationFreshnessExhausted` and deletes only the
run's marker. These rules prevent a silent `(marker, no PR)` orphan. The PR diff
contains only permitted public manifest version fields and changelog files plus
bounded release metadata.

### Operator recovery

For a failed request, open the run summary and follow its recovery link. Fix
source or documentation failures on `main`, then dispatch a new request. For
`CreationCleanupPending`, run the read-only doctor first and use its resume
command only after it reports the authoritative marker and PR state. Do not
manually delete `release-pr/stable` or edit the release PR to repair a failed
creation.

### Automatic regeneration

[`release-stable-regenerate.yml`](../../.github/workflows/release-stable-regenerate.yml)
starts only from a push to `main`. `workflow_dispatch` is a guarded maintainer
retry, not a request to create or prepare a release. It never creates a PR, and
there is no shared release-PR concurrency group. Task 9 marker ownership and
CAS leases provide writer coordination while every main push remains eligible.

The detect phase is read-only. No marker and no open stable PR is a neutral
successful no-op. A marker without a visible PR is creation-in-progress and
gets a bounded wait. Neither state creates a PR. A self release merge or
Changeset-cleanup merge skips regeneration only when no pending Changeset
changed. A changed pending set continues through the pipeline.

The plan, docs-release-audit, changelog-ai, and update-pr jobs use separate
credentials and bounded, SHA-bound artifacts. The docs re-audit runs the
Task 19 deterministic checker and required AI gate at the latest green `main`
SHA. Only update-pr calls Task 9 `regenerate`, with the release App credential;
no other job can mutate the PR. A docs failure leaves the PR and marker
byte-identical, publishes the typed `docs-audit` blocking check, and keeps the
`release-policy` freshness check blocking merge. Fix `main` and rerun; do not
manually edit the marker.

A successful update preserves human edits when the `sourceChangesets` identity
set is unchanged. It asks AI only for new or changed identity sets. If a human
edit conflicts with newly generated prose, `EditConflict` returns both versions
and leaves the PR unchanged. The result records explicit
`automatic-main-advance` or `maintainer-retry` attribution and
`regeneratedFrom` audit provenance.

Task 9 rechecks `main` immediately before CAS, uses force-with-lease, retries
within a bound, rejects non-monotonic freshness, and returns
`RegenerationSuperseded` when another run wins so later runs converge. Ruleset
stale-approval dismissal and the required `release-policy` freshness check
invalidate approvals tied to an older base. Recovery is to resolve the docs or
prose issue, wait for a new `main` push, or use the guarded retry. Never create
a replacement PR.

## Pi acceptance assets

Machine-consumed Pi acceptance files live under [`scripts/release/pi-acceptance/`](../../scripts/release/pi-acceptance), not in documentation. Generation and validation scripts own their format. Human documentation may link to them but must not duplicate their requirement rows.
