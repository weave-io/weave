# Task 20(h) — Session transition Stay then cancel-then-switch

Date: 2026-08-06

Result: **PASS**

Checklist version `3`. Matrix item `(h)` against exact subject `16593bf` in
`$HOME/.local/share/weave/task20-pi083-harness`.

Aggregated evidence:

1. Attempt 1 proved vetoable Stay-default preservation (source parent, live
   child, draft, overlay) on the same subject/artifact.
2. Attempt 2 failed before child launch (`/tree` + external editor trap); not
   used for PASS assertions beyond provenance/cleanup lessons.
3. Attempt 3 (this run) completed Proceed cancel-then-switch, destination
   activation once, source `--session` reconstruction of one canceled child,
   CSM 0, focused tests, docs links, and cleanup — without `/tree` or `/resume`
   before the transition, with `EDITOR`/`VISUAL`/`GIT_EDITOR=true` no-ops.

Plan checkbox not marked.

## Aggregated assertion matrix

| Assertion | Attempt 1 | Attempt 3 | Combined |
| --- | --- | --- | --- |
| Fresh pane Pi 0.83.0 exact `16593bf` artifact; unsafe override absent | **PASS** | **PASS** | **PASS** |
| Active shuttle-mini + overlay/history evidence before transition | **PASS** | **PASS** (compact `running`) | **PASS** |
| Vetoable transition prompt; default Stay preserves source/child/draft/overlay | **PASS** | not repeated | **PASS** (attempt 1) |
| Cancel-then-switch activates destination once; source child canceled; lease released | partial | **PASS** | **PASS** |
| Source return reconstructs one canceled child; no dup rows / active lease | **NOT RUN** | **PASS** | **PASS** |
| Reentrant/duplicate transition fail-closed | **PASS** (dialog hold) | **PASS** (one Proceed → one dest) | **PASS** |
| `childSettlementMissingCount: 0`; checklist v3; subject/digests/host/run | **PASS** | **PASS** | **PASS** |
| Cleanup created pane; preexisting preserved; no leftovers | **PASS** | **PASS** | **PASS** |
| Focused transition/session-manager/reconstruction/overlay tests + docs links | **PASS** (173) | **PASS** (206 / docs EXIT 0) | **PASS** |
| Unrelated overlay/CodeSight WIP preserved | **PASS** | **PASS** | **PASS** |
| Commit item-(h) proof | pending | **PASS** | **PASS** |

## Attempt 3 (Proceed + source-return) — PASS

### Subject and artifact

| Field | Verified value |
| --- | --- |
| Subject HEAD | `16593bf8e2ec5530163704359594a63eafec28e1` |
| Host Pi in pane | `0.83.0` via `$ISO/shim/pi` |
| Global Pi (untouched) | `0.84.0` |
| Artifact | `$ISO/pi-agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-16593bf-task20iso-f8db0f7f7419.tgz` |
| Artifact SHA-256 | `f8db0f7f741979b5c39e371f67a8471c00e66ec8a77bb9e6163fa527fd070eb3` |
| Installed `dist/extension.js` | `e86463ff54577e5a78384bf2da1e8b7f336c3a4b9aa9dc1517333ba85d70baba` |
| Installed `dist/index.js` | `83aa6831e6e7a79cd20c732d495bb703f6484f1a6cef1feeea8310ba296201c3` |
| Installed `dist/cli.js` | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |
| Tarball vs installed digests | match |
| Provenance | `npm:@weaveio/weave-adapter-pi` (not a symlink) |
| Packages during run | `npm:@weaveio/weave-adapter-pi` only (pi-vim removed for this item, restored after) |
| `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` | unset in shim |
| Local extension shadow | absent under `$ISO/pi-agent/extensions` |
| Host | `joses-Apple-MacBook-Pro` |
| Pane / agent | `w23:pC2` / `task20h3` (source+transition); restart `w23:pC3` / `task20h3r` |
| Run id | `H16593C` |
| Named source | `TASK20H3SRC` |
| Source session id hash | `fa7dcf238d7cda4c` |
| Source generation hash (pre-transition) | `14d7946afdcc6760` |
| Destination generation hash | `bd347f495724a596` |
| Child id hash | `a1188489a91a2612` |
| `childSettlementMissingCount` | `0` |

### Environment

```yaml
piVersion083: true
ready: true
trust: trusted
healthOnly: false
npmProvenance: true
unsafeOverrideAbsent: true
localExtensionShadowAbsent: true
piVimDisabledForItem: true
editorNoOp: true
transitionRoute: app.session.new/ctrl+n
identitySource: iso-session-file+/weave:status
hardLimitSeconds: 600
treeOrResumeBeforeTransition: false
```

### What passed in attempt 3

| Observation | Sanitized value |
| --- | --- |
| Exact digests / provenance / no unsafe override | `true` |
| Named persistent source activated | `true` (`TASK20H3SRC`) |
| Source session file persisted under ISO sessions | `true` |
| Direct parent prompt (no `/tree`, `/resume`, editor) | `true` |
| Live `shuttle-mini` compact before transition | `true` (`weave_delegate · shuttle-mini · running`) |
| Transition dialog Stay default + Proceed option | `true` |
| Proceed selected via ↓+Enter | `true` |
| Destination `New session started` exactly once from Proceed | `true` |
| Destination generation distinct from source | `true` |
| Destination `/weave:status` children | `0` |
| Source child terminal settlement | `cancelled` (`{"ok":true,"settlement":{"outcome":"cancelled"}}`) |
| Lifecycle child-ref status | `cancelled` |
| Runtime lease after Proceed | none |
| Source `--session` restart reconstructs one canceled row | `true` (`CHILD_STATUS=cancelled COUNT=1`) |
| History compact after restart | `weave_delegate · shuttle-mini · cancelled` |
| Duplicate canceled rows | `false` |
| Read-only status/history inspect | `true` |
| Focused tests on detached `16593bf` | `206` pass / `0` fail |
| `bun run docs:check-links` | PASS |
| Unrelated WIP SHA-256 baseline identical | `true` |
| Created panes closed; preexisting `w23:p79 w23:p70` preserved | `true` |
| ISO settings restored with `npm:pi-vim` | `true` |
| Residual ISO Pi process after cleanup | `false` |
| Editor temp leftovers | `false` |

### Pane note (source-return)

Destination exit used `ctrl+d`, which closed shell pane `w23:pC2`. Source
reconstruction therefore ran in replacement pane `w23:pC3` in the same tab with
the same ISO shim, no-op editors, and exact
`--session <captured-source-file>`. Reconstruction evidence is authoritative
from the ISO session file + restarted TUI status/history.

### Exact outcome and cleanup

```text
PASS
```

Pre-existing panes at start: `w23:p79 w23:p70`. Created panes closed.
Remaining: `w23:p79 w23:p70`. Isolated settings restored with `npm:pi-vim`.
Temporary `16593bf` worktree removed. Artifact retained under
`$ISO/pi-agent/npm/artifacts/`.

```yaml
currentResult: PASS
childProcessRemaining: false
runtimeStoreLeaseActive: false
createdPaneClosed: true
preexistingPanesPreserved: true
proofCommitted: true
planCheckboxMarked: false
unrelatedOverlayWipPreserved: true
childSettlementMissingCount: 0
```

## Attempt 1 (Stay-default) — retained

Attempt 1 evidence remains valid for Stay-default preservation on the same
subject/artifact. Summary:

### Subject and artifact

| Field | Verified value |
| --- | --- |
| Subject HEAD | `16593bf8e2ec5530163704359594a63eafec28e1` |
| Host Pi in pane | `0.83.0` via `$ISO/shim/pi` |
| Artifact SHA-256 | `f8db0f7f741979b5c39e371f67a8471c00e66ec8a77bb9e6163fa527fd070eb3` |
| Installed `dist/extension.js` | `e86463ff54577e5a78384bf2da1e8b7f336c3a4b9aa9dc1517333ba85d70baba` |
| Installed `dist/index.js` | `83aa6831e6e7a79cd20c732d495bb703f6484f1a6cef1feeea8310ba296201c3` |
| Installed `dist/cli.js` | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |
| Pane / agent | `w23:pB0` / `task20h1` |
| Run id | `H16593` |
| `childSettlementMissingCount` | `0` |

### What passed

| Observation | Sanitized value |
| --- | --- |
| Active shuttle-mini child before transition | `true` |
| Overlay opened / remounted after Stay | `true` |
| Primary draft seeded | `true` (`TASK20H_DRAFT_H16593`) |
| Transition confirmation shown | `true` |
| Stay and Proceed options present | `true` |
| Enter default kept source session + live child | `true` |
| Draft preserved after Stay | `true` |
| Reentrant duplicate `ctrl+n` held dialog / source fp | `true` |
| `ChildSettlementMissing` | `0` |
| Focused tests | `173` pass / `0` fail |
| Docs links | PASS |

## Attempt 2 (blocked) — retained as non-PASS path

Attempt 2 started named source `TASK20H2SRC` under exact digests but entered
`/tree` and an external editor before any live child; Proceed/source-return were
not run. Cleanup and provenance checks passed. Not used for combined PASS
beyond confirming the no-`/tree`/no-editor constraint for attempt 3.

## Repository checks (detached `16593bf` worktree, attempt 3)

| Check | Result |
| --- | --- |
| Focused session-transition / live-session-manager / reconstruction / overlay tests | **206 pass**, 0 fail |
| `bun run docs:check-links` | PASS |
