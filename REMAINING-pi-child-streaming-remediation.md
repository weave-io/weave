# Remaining: Pi child streaming remediation

## Checkpoint

- Branch: `feat/pi-stale-runtime-identity-gate`
- Checkpoint base: `ea18f0324b06f69b560b704a6186318173c7bcce`
- Plan: `.weave/plans/pi-child-streaming-remediation.md`
- Plan status: Tasks 1–10 complete; Task 11 remains unchecked.
- Worktree was clean before this note.

Do not modify or restore shared `~/.weave/config.weave` or shared Pi settings. Use an isolated temporary `HOME`, config root, Runtime Store, data directory, and session directory for all remaining tests and proofs.

## Completed work

### Tasks 1–10

| Area | Commits |
| --- | --- |
| Exact stale-runtime identity gate | `845557f8` |
| Authoritative Pi 0.84.2 capture/replay | `c77389ed` |
| Bounded content-free diagnostics | `d2b2d50a`, `d8c446ca` |
| Bounded live reasoning projector | `f0a4a10d` |
| Parent-card TUI-only reasoning | `ea87a49e`, `0e5ebb38` |
| Inspector reasoning | `a066752d` |
| Incremental inspector assistant | `1aff1989` |
| Correlated inspector tool details | `09fb0dfa` |
| Contract and red-control tests | `0a059fa4` |
| Normative docs and initial proof record | `bd8091ea`, `695e15a2` |

### Task 11 implementation and review remediations

- Live fanout, cleanup, and exact-lane coverage: `4ba81ed0`, `6063e490`, `50aab65e`, `ed098688`.
- Proof history and exact-isolated evidence: `9aa25ef1`, `450d1a6f`, `b268357b`, `ea2c0f2f`, `684f4300`.
- Complete loaded-output identity and trusted preloader: `12588437`, `ec8e53e2`, `947b3237`, `6a823686`.
- Live-reasoning and capture decomposition: `343b7d05`, `4697989a`.
- Parent unprintable marker: `69e79e42`.
- Executable bounded live verifier: `a727dfa9`, `5b39eec4`, `3f6f1980`.
- Terminal lifecycle retention isolation: `f6f06e04`.
- Stream deadlines, output bounds, and late-spawn cleanup: `c3282f90`, `d4d3be76`, `99826df8`, `be3ebdb8`.
- Probe environment isolation: `6a045779`.
- Shared bounded process and capture/host I/O: `c8d9fd75`, `ff7277d5`, `d1974a93`.
- Identity, verifier, contract, path, and build decomposition: `e9459c5f`, `03908522`, `a466ddd3`, `444afd00`, `e46f68d5`.
- Bounded identity reads and trusted symlink containment: `81b9a23f`, `5ac96329`.
- Temporary build-root cleanup: `b46fb066`.
- Native overlay/test decomposition: `b5cc4339`.
- Real child extension argument propagation: `1a01768c`.
- Real-host bootstrap test moved to the scripts boundary: `e4c38942`.
- Obsolete mutable-disk identity API removed: `57355ca9`.
- Final combined proof record: `ea18f032`.

Generated CodeSight-only commits also exist in the range. Use this command for the complete ordered history:

```bash
git log --reverse --oneline be8231415fe05f1f6432c1652e116c5a6586c8bc..ea18f0324b06f69b560b704a6186318173c7bcce
```

## Exact unfinished work

### 1. Fix inspector tool-data sanitization

Warp found that tool argument/result previews can retain embedded paths and credentials.

Relevant code:

- `packages/adapters/pi/src/child-overlay-pi-native-values.ts`
- `packages/adapters/pi/src/child-session-events.ts`

Required behavior:

- Redact embedded POSIX, home, and Windows absolute paths, including values such as `path=/etc/passwd` and `cwd=/opt/project`.
- Redact common credential forms, including `Authorization: Basic`, `Authorization: Bearer`, `Cookie`, `Set-Cookie`, session/token/key/password assignments, URL userinfo, and secret query values.
- Keep useful bounded repository-relative tool data.
- Do not apply semantic filtering to raw reasoning.
- Add red and false-positive tests for event retention and native inspector rendering.

### 2. Make the live verifier's isolation gate authoritative

Warp found that K1 inspects retained event serialization and overlay rendering, then overmaps those checks to parent-card, model, and durable isolation.

Relevant code:

- `scripts/pi/child-stream-live-proof-observer.ts`
- `scripts/pi/child-stream-live-proof-port.ts`

The verifier must separately and structurally inspect:

- Parent conversation messages and model input.
- Partial and final tool `content` and persisted card `details`.
- Parent-card facts and rendered activity.
- Runtime Store records.
- Inspector checkpoints, transcript/replay/search state, and logs.
- Fixture and report objects.
- Separate parent-card and inspector reasoning registries.

The production proof child must load Weave, not only the deterministic provider. Each sink needs its own closed result. Do not infer durable isolation or registry release from process exit or empty general stores.

### 3. Re-run the affected gates

After both fixes:

1. Run focused sanitizer, event-retention, overlay, card, model-message, Runtime Store, checkpoint, log, fixture, registry, and live-verifier tests.
2. Run full Pi tests, script tests, typecheck, lint, build, config validation, and docs links.
3. Run the real installed Pi 0.84.2 live command with an isolated temporary environment.
4. Run a fresh Herdr proof if the adapter runtime output changes.
5. Run Weft. Fix every blocker.
6. Run mandatory Warp over the full Task 11 scope. Fix every blocker.
7. Update the proof append-only with the final reviewed subject and bounded evidence.
8. Check Task 11 only after both Weft and Warp approve.

## Validation already completed

Latest recorded validation before this checkpoint:

- Full repository: `11,298` passed, `12` skipped, `0` failed.
- Pi adapter: `4,237` passed, `0` failed.
- Script suite: `182` passed, `1` opt-in real-host test skipped by default.
- Build, typecheck, lint, declaration validation, config validation, and documentation links passed.
- Real-host bootstrap test proved `ChildHandshakeMissing` before child extension argument propagation and `bootstrap-ack` after the fix.

### Live evidence already recorded

J8, at subject `57355ca9`, recorded content-free fresh normal-provider Herdr facts:

- Children: `1`.
- Parent live reasoning row: present.
- Inspector opened while live; reasoning present.
- Tool starts/results: `1/1`; duplicate terminals: `0`.
- Assistant samples: `2`; growth: `1`.
- Authenticated result chunks/commits: `1/1`.
- Settlements: `1`.
- Cleanup resources: `0`.

J8 correctly remained RED for isolation and registry authority because its operator did not retain authoritative sink records.

K1, at the same subject and `extension-impl` digest, reported exit `0`, lanes `4/4`, one settlement, zero registry counts, clean diagnostics, and cleanup. Warp later rejected K1's isolation authority because the observer did not inspect all claimed sinks. Do not treat K1 as final Warp evidence until blocker 2 is fixed.

### Reviews already completed

- Weft approved the code at `57355ca9`.
- Weft approved the combined L1 proof at `ea18f032`.
- Warp blocked final approval on the two issues above.

## Current blocker

`shuttle` and `thread` currently fail immediately with:

```text
assistant error · details unavailable
```

The failure also occurs for a no-op delegation. Do not work around this by changing shared global configuration. Wait for the current Weave provider route to recover or for the user to repair it.

## Next safe action

1. Confirm the task worktree is clean:

   ```bash
   cd /Users/jose/projects/weave.worktrees/task1-stale-runtime-identity-gate
   git status --short
   ```

2. Retry a no-op Weave Shuttle delegation. Do not inspect or modify shared configuration.
3. When Shuttle is available, delegate unfinished item 1 first from the clean checkpoint.
4. Use isolated temporary roots for all test and proof state.
