# Remaining release pipeline replacement work

This checkpoint records the state of [the release pipeline replacement plan](.weave/plans/release-pipeline-replacement.md) on 2026-08-21.

## Protected-main baseline

Protected `origin/main` is `7d6a58cae083f0695bfe86035a3fb2a1652087a0`.

Tasks 1–31 are complete in the plan. The main release integration and its follow-up repairs are:

- `d8edab1e053f99810227e477e1da04db3c6bea94` — pre-cutover release pipeline integration, including the Task 31 security work. The focused Task 31 source commit was `389bc30d` before integration.
- `e37e39717f1ac0dbea3f98a8553e0680b32e7f60` — short-lived GitHub App token minting.
- `7d6a58cae083f0695bfe86035a3fb2a1652087a0` — authoritative legacy publisher preflight.

Do not treat any unmerged commit below as protected-main behavior.

## Open and unmerged work

### PR #155 — deterministic docs policy repair

- URL: <https://github.com/weave-io/weave/pull/155>
- Head: `a3c15764e2fdc24fc569e1680cc616dce24929a0`
- State: open and unmerged.
- Recorded validation: 97 docs tests and 1,261 script tests passed. Typecheck, docs build, docs links, and the real deterministic audit passed with zero issues.
- Review remains blocked on the duplicate runtime fallback route inventory, missing validation that compatibility routes resolve to content, and invalid/unbounded link-check limit handling.

### PR #156 — authoritative doctor lifecycle repair

- URL: <https://github.com/weave-io/weave/pull/156>
- Head: `cfda5b9703f97b7675532037b34b55e02478c2fd`
- State: open and unmerged.
- Recorded validation: 1,312 script tests passed. Focused doctor, authority, transport, and GitHub-client tests passed. Typecheck and docs links passed.
- Review remains blocked because the production collector does not yet use the canonical Task 14 plan, ledger, rebuild, proof, cleanup, and incident authority. The cleanup record lacks a canonical production writer/schema. Incident evidence is not bound to the exact protected workflow and trusted App. Environment review must bind to the exact release-maintainers team.

### Draft PR #158 — Task 35 static cutover preparation

- URL: <https://github.com/weave-io/weave/pull/158>
- State: draft and unmerged.
- `b49b096b` — remove the legacy publisher at cutover.
- `a8f553a9` — route scheduled events to nightly.
- `25579e44` — remove the retained legacy preflight.
- Recorded validation:
  - Initial Task 35 script suite: 1,169 passed.
  - Schedule-routing focused suite: 46 passed.
  - Post-legacy-removal release suite: 1,129 passed.
  - Typecheck, lint, docs links, action-pin checks, and CODEOWNERS checks passed in the recorded runs.
  - The protected-main baseline has 16 reproducible full-suite failures. This draft did not fix or introduce them.

PR #158 must not merge in its current state. The checked-in rollout stage remains `pre-cutover`; no freeze record exists; no npm trust switch occurred.

## Exact unfinished tasks

### Task 32 — one-time pre-cutover setup

Status: explicitly skipped by the user, but incomplete.

Required work includes GitHub environments, environment reviewers, ruleset checks, stale-approval dismissal, the release-maintainers team, the release GitHub App, environment secret names, repository rollout variables, authenticated npm ownership and trust reads, model reachability, authoritative lifecycle state, and a green `release:doctor --pre-cutover` result ending in `ReadyForCutover`.

No npm trusted-publisher record may change during Task 32. CLI and OpenCode must retain the old `publish.yml` identity until the Task 35 freeze.

### Task 33 — live recovery and failure drills

Status: explicitly skipped by the user, but incomplete.

The local hermetic incident integration item `(i5)` passed once. The release suite passed 1,084 tests. The other 15 live workflow evidence items remain blocked by the skipped Task 32 setup.

Evidence: <https://github.com/weave-io/weave/issues/143#issuecomment-5360031908>

### Task 34 — candidate readiness

Status: explicitly skipped by the user, but incomplete.

Three candidate tarballs passed inventory and source-immutability checks:

- CLI: `sha256:6e83ebbc37751d52ac4c34aec88ae16ff2713bceecb6c9dc1c85b211aac5b344`
- OpenCode: `sha256:2bea95341ce6d7505c7be4fec322468c7b201ca45da252be17622c899afafc40`
- Claude Code: `sha256:8194bde7191e9df9b4ec65b805c0f69e15655df53b340ea8fa0550fa2a33a2d1`

Protected main does not contain a coherent Pi product tree, so the fourth tarball and all four clean-consumer results were not produced. All six adapter-host proof cells were blocked by the skipped harness environment and API-key setup.

Evidence:

- <https://github.com/weave-io/weave/issues/143#issuecomment-5360227249>
- <https://github.com/weave-io/weave/issues/143#issuecomment-5360237723>

A Pi-only restoration was proven unsafe and PR #157 was closed without merge. The coherent Pi snapshot depends on coupled core, config, engine, CLI, and adapter changes.

### Task 35 — cutover

Status: draft and incomplete.

The remaining code blocker is the real release-ref runtime seam:

1. `.github/workflows/release-publish.yml` does not produce or download a complete refs-and-cleanup carrier.
2. `scripts/release/refs-cleanup-main.ts` validates and rewrites a hand-off file but does not call `ReleaseRefsController`.
3. The carrier lacks the complete plan, closure, publication report, changelog, ledger, and exact-`releasedSha` data required by `ReleaseRefsInput`.
4. `GitHubRestClient` lacks the narrow annotated-tag, nullable release-read, rich release-create, and cleanup deletion-commit adapters required by the existing controllers.
5. The runtime must call `ReleaseRefsController` only after every closure member is registry-digest-verified, then run changeset cleanup only after the complete refs batch succeeds.
6. Keeper and reachability tests must require a runtime value edge; a type-only import is not proof.

After the code is complete, Task 35 still requires quiescence, `RELEASE_ROLLOUT_MODE=disabled`, a reviewed frozen-stage record, the interactive CLI/OpenCode npm trust switch, a frozen-event `RolloutDisabled` proof, and `release:doctor --cutover` ending in `CutoverVerified`.

### Tasks 36–40

Status: not started.

- Task 36: consolidate release documentation after Task 35.
- Task 37: scratch-stage and manually publish Claude/Pi `0.0.0` under `bootstrap`, verify exact registry digests, and configure trusted publishers.
- Task 38: verify all four trust records under the frozen tuple, land the reviewed `ready` stage with mode still disabled, then perform the single enabled-variable flip and final doctor verification.
- Task 39: run the inaugural exact-`releasedSha` `0.1.0` stable release for all four packages through the complete proof and publication chain.
- Task 40: interactively remove bootstrap/preview tags, deprecate old versions, and verify registry read-back. Never unpublish.

## Human and external prerequisites

A maintainer must provide or perform:

- GitHub environments and exact reviewer protection.
- Main ruleset required checks and stale-approval dismissal.
- Release-maintainers team and GitHub App installation.
- Environment secret names and API-key credentials.
- Authenticated npm ownership and trusted-publisher reads.
- Cutover quiescence and rollout-variable changes.
- Interactive npm trust switches, bootstrap publication, and deprecation/tag cleanup with login and 2FA.
- Release and prerelease environment approvals.

CI must never receive an npm token and must never run `npm deprecate`.

Do not edit, restore, replace, chmod, or snapshot/restore `~/.weave/config.weave` or shared Pi settings. Treat the user’s current Shuttle configuration as authoritative. Every test and proof must use an isolated temporary `HOME`, config root, runtime root, and data root.

## Validation still required

Before cutover and release, run and record:

- The full repository gate: frozen install, lint, typecheck, build, all tests, docs links, action pins, CODEOWNERS, API reports, Changesets policy, and the doctor mode for the current rollout rung.
- Adversarial Weft and Warp approval for PRs #155, #156, and #158 after every blocker is fixed.
- Task 32 `ReadyForCutover` evidence.
- All 16 Task 33 evidence items.
- All Task 34 consumer and six adapter-host readiness cells.
- Task 35 quiescence, freeze, trust switch, disabled-event, and `CutoverVerified` evidence.
- Task 37 bootstrap digest and trusted-publisher evidence.
- Task 38 `ReadyForActivation`, `ActivationReadyVerified`, and final enabled-mode evidence in strict order.
- Task 39 exact-byte publication, provenance, attestation, consumer, harness, registry, tag, release, cleanup-PR, and terminal `Complete` evidence.
- Task 40 dist-tag and deprecation read-back evidence.

## Next safe action

Continue draft PR #158 in an isolated task worktree. First implement the Thread-mapped complete refs carrier and bounded GitHub adapters. Then value-import and call `ReleaseRefsController` from the workflow-invoked runtime, call changeset cleanup only after refs succeed, run focused and full validation in isolated roots, and repeat Weft/Warp review.

Do not merge PR #158, enter the freeze, change npm trust, or enable publication until the skipped Tasks 32–34 are intentionally restored and completed.

A safe first check is:

```bash
git -C /private/tmp/weave-release-pipeline-checkpoint status --short
git -C /private/tmp/weave-release-pipeline-checkpoint rev-parse HEAD
```
