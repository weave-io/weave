# Remaining: Pi transparent runtime model fallback

## Checkpoint

- Integration branch: `integration/all-active-workstreams`
- Source branch: `feat/pi-native-child-stream-rendering`
- Plan: `.weave/plans/pi-transparent-runtime-model-fallback.md`
- Plan bookkeeping HEAD: `6ec58fc69dd2787de04337485234062f03f870af`
- Tasks 1–15 are complete.
- Tasks 16–17 remain unchecked.
- Approved live-candidate source: `24ab92cd503e2c74773f2d55e7cb08a47952e9b8`

## Completed commits for issue 146

The early post-recovery-hook attempts were superseded by the public lifecycle implementation:

- `819387af` — specify the post-recovery hook contract
- `4a768cdf` — declare the post-recovery hook capability
- `c715e9ee` — keep the post-recovery hook capability adapter-owned

Current implementation and verification commits, in order:

- `da478aa0`, `47caa72b`, `f3f164b4`, `d0d3d914`
- `19129996`, `5b5adff5`, `534800f2`, `5a54ae2b`
- `7c5ab1a3`, `c98eb340`, `f0340b65`, `a7241c0f`
- `64cc564c`, `414f047e`, `22fe0edc`, `bcd3257d`
- `0cf99a52`, `a2932087`, `29d2c5a0`, `24585037`
- `e32a160a`, `9c1d5d43`, `87afd8cc`, `1d80e8d1`
- `d5bb09f3`, `44d83729`, `02208658`, `187b1bbe`
- `6d541ee5`, `420eba07`, `f7c303f9`, `9d7c7132`
- `40a46daa`, `5aef0131`, `6c02a9b1`, `18bdf2e7`
- `fd1afa46`, `5dcf8ba5`, `45b20d9b`, `24ab92cd`
- `6ec58fc6`

Weft approved the exact source and deterministic adapter artifact. The adapter artifact SHA-256 was `437f99108a5a85e6dcb9134ebf58180f1a1c15ad90aba51c0d5b3cf95a42a439`; the extension SHA-256 was `39204d150dff6cd54cc0187f281c1466b46f6356333caab38f38ed44bf381aae`.

## Prior Task 15 live proof

The prior Pi 0.84.2 smoke exited 0. Its sanitized report had SHA-256 `e902a7d642f820baf4ac0553d98c8fbf2c1e6fcbd7a3caa697689d4de8abcc30`, mode `0600`, and size 7,923 bytes.

Bounded proof facts:

- Provider: 3 descriptors.
- Durable state: 14 entries and 6 descriptors.
- Lifecycle: 6 starts, 6 ends, 3 context events, 1 repair, and 1 selection.
- Visible transition events: 1.
- Applied model: `smoke/second`.
- Evidence source: Native Line.
- Parent settlements: exactly 1 final settlement.
- Rollback: ready, health-only false, and one legacy settlement.
- Every cleanup fact was true.

The ephemeral artifact and report were later deleted concurrently. Their old paths are not inspectable evidence. Task 16 must regenerate and preserve fresh bounded evidence for Warp.

## Validation already completed

At exact source `24ab92cd`:

- Focused suites: 59, 163, and 272 passed.
- Smoke suite: 72 passed.
- Remediation suite: 464 passed.
- Full Pi suite: 4,347 passed.
- Release suite: 1,287 passed, apart from one proven pre-existing `fixture-seam-isolation` failure.
- Root suite: 11,720 passed and 11 skipped, with the same baseline failure.
- Typecheck, lint, API reports, declarations, build, config validation, docs links, singleton verification, direct bundle verification, and diff checks passed.
- Weft returned `[APPROVE]` for the exact source and artifact.

## Task 16 remaining work

1. Regenerate the byte-identical artifact from `24ab92cd` in isolated temporary roots.
2. Run a fresh sanitized live report and preserve readable artifact/report paths and hashes.
3. Obtain Warp approval against every scope exclusion and every Task 7, 9, 10, and 15 acceptance item.
4. If any code changes, repeat Task 13 verification, Weft review, build, live proof, and Warp review.
5. Mark and commit Task 16 only after approval.

The next safe evidence root is `/private/tmp/weave-pi-model-fallback-task16-evidence-24ab92cd-final/`. Rebuild there, require the artifact SHA, and run the exact smoke command with `--artifact-sha256`, `--expected-pi-version 0.84.2`, `--case all`, and an explicit report path. Preserve the artifact and report for Warp.

## Task 17 remaining work

1. Preserve the Warp-approved artifact and hashes.
2. Install the exact artifact through the normal local Pi development or release path.
3. Restart Pi and prove ready/health plus one nonfailure delegation smoke.
4. Restore the prior artifact and restart for the legacy-ready rollback proof.
5. Restore the new artifact, restart, and clean every owned resource.
6. Record final status and cleanup evidence.

Do not modify or restore shared global Weave config or shared Pi settings. Use isolated temporary HOME, config, runtime, data, cache, and temporary directories.

## Current blockers

- Fresh preserved Task 16 evidence is still absent.
- The latest Warp delegation on the integrated branch returned `assistant error · details unavailable`; no current security approval exists.
- Task 17 installation, rollback, and cleanup proof has not run.

Do not override the user's authoritative Shuttle route or modify shared configuration to bypass these failures. Regenerate isolated evidence first, then run Warp.
