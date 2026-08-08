# Task 20(f) — Retry / continue frozen-block proof

Date: 2026-08-06

Result: **PASS**

Checklist version `3`. Matrix item `(f)` against exact subject `16593bf` in
`$HOME/.local/share/weave/task20-pi083-harness`. Fresh isolated Pi 0.83 pane
canceled one bounded shuttle-mini thread, retried it to a distinct successful
terminal block while the canceled compact block stayed frozen, continued the
same thread to another distinct terminal block while prior blocks stayed
byte-identical, proved wrong-state fail-closed diagnostics, then restarted the
parent from the same session file and showed Retry/Continue still consulted
authoritative thread metadata. Plan checkbox not marked.

## 16593bf isolated-harness attempt — PASS

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
| `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` | unset (`OVERRIDE=[unset]`) |
| Local extension shadow | absent under `$ISO/pi-agent/extensions` |
| Host | `joses-Apple-MacBook-Pro` |
| Pane / agents | `w23:pBY` / `task20f1` then restarted `task20f1r` |
| Run id | `F16593` |
| Thread prefix | `a7073c7d…` (opaque UUID from session `threadId`) |
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
nativeOverlayMountRoute: alt+i+enter
cancelRoute: esc+esc+down+enter
```

### Cancel → Retry frozen-block

A bounded live shuttle-mini child was mounted with `Alt+I` / `Enter`, then
canceled through the supported double-Escape confirm path (`Cancel subtree`).
No `ChildSettlementMissing` occurred.

| Observation | Sanitized value |
| --- | --- |
| Old terminal compact block state | `cancelled` |
| Old block run/action | `run 1 · start` |
| Old block SHA-256 | `d448937655312142bc090851afd286b87e29869cd57dd05cde413b4cf74a075a` |

Retry with the opaque thread handle created run 2:

| Observation | Sanitized value |
| --- | --- |
| New block state | `completed` |
| New block run/action | `run 2 · retry` |
| New block SHA-256 | `0e5e50613ca69fa5f03f259847b258ba9dfc1283a0d3b6f563aad4981dc077e0` |
| Old canceled block unchanged | `true` (same SHA-256 still present) |
| Pass marker | `TASK20F_RETRY_PASS_F16593` |

### Continue frozen-block

Continue on the same completed thread created run 3:

| Observation | Sanitized value |
| --- | --- |
| New block state | `completed` |
| New block run/action | `run 3 · continue` |
| New block SHA-256 | `7e55191fcac9a2325e2b0e1b291036f106d7561baf666c11a205860274977da5` |
| Prior retry-completed block unchanged | `true` |
| Prior canceled block unchanged | `true` |
| Pass marker | `TASK20F_CONT_PASS_F16593` |

### Wrong-state fail-closed

| Combination | Typed code | Bounded / no prompt-transcript dump |
| --- | --- | --- |
| Retry completed thread | `ThreadNotRetryable` | `true` |
| Continue arbitrary thread | `ThreadNotFound` | `true` |
| Continue non-completed (canceled) thread | `ThreadNotResumable` (`status-not-completed`) | `true` |

### Parent restart from authoritative metadata

Parent restarted with `--session` on the same isolated session file. After
restart:

- Continue on the primary thread returned typed `ThreadAlreadyRunning` from
  authoritative metadata (not `ThreadNotFound` / authority denial), proving the
  Continue route remains available after restart.
- Retry on a canceled sibling thread remained available (`restartRetryAvailable:
  true`).
- Prior compact-block hashes for cancel / retry-completed / continue-completed
  remained observable and unchanged.

```yaml
restartContinueAvailable: true
restartContinueThreadAlreadyRunningObserved: true
restartRetryAvailable: true
frozenBlocksStillObservable:
  cancel: true
  retryCompleted: true
  continueCompleted: true
childSettlementMissingCount: 0
rpcChildCount: 0
```

### Assertion matrix

| Assertion | Result | Sanitized evidence |
| --- | --- | --- |
| Fresh pane runs Pi 0.83.0 with exact `16593bf` npm artifact; unsafe override absent | **PASS** | Version/digests matched; override unset; shadow absent |
| Bounded child canceled to retryable terminal without `ChildSettlementMissing` | **PASS** | `cancelled` run 1; CSM `0` |
| Retry preserves lineage, distinct attempt/block, old block frozen, terminal success | **PASS** | run 2 · retry completed; old SHA unchanged |
| Continue on completed thread creates distinct block; old completed/canceled frozen | **PASS** | run 3 · continue completed; both prior SHAs unchanged |
| Wrong-state Retry/Continue/arbitrary fail closed with bounded typed diagnostics | **PASS** | `ThreadNotRetryable` / `ThreadNotResumable` / `ThreadNotFound` |
| Retry/Continue available after parent restart from authoritative metadata | **PASS** | Restart Continue → `ThreadAlreadyRunning`; Retry available |
| `childSettlementMissingCount: 0`; checklist v3; subject/artifact/digests/host/run | **PASS** | Evidence record above |
| Cleanup: created pane closed; preexisting panes preserved; no rpc/lease leftovers | **PASS** | Remaining `w23:p79 w23:p70`; rpc `0`; no active lease |
| Focused thread/retry/continue/overlay tests + docs links from clean `16593bf` | **PASS** | `213` pass / `0` fail; docs links EXIT `0` |
| Unrelated overlay/CodeSight WIP preserved byte-for-byte | **PASS** | Pre/post SHA-256 baseline identical |

### Repository checks (detached `16593bf` worktree)

| Check | Result |
| --- | --- |
| Focused thread-lifecycle / delegation-tool / child-overlay tests | **213 pass**, 0 fail |
| `bun run docs:check-links` | PASS |

### Exact outcome and cleanup

```text
PASS
```

Pre-existing panes at start: `w23:p79 w23:p70`. Created pane `w23:pBY` closed.
Remaining: `w23:p79 w23:p70`. Isolated settings restored with `npm:pi-vim`.
Temporary `16593bf` worktree removed. Artifact retained under
`$ISO/pi-agent/npm/artifacts/`.

```yaml
currentResult: PASS
sanitizedBlockerOutcome: null
childProcessRemaining: false
runtimeStoreLeaseActive: false
createdPaneClosed: true
preexistingPanesPreserved: true
proofCommitted: true
planCheckboxMarked: false
unrelatedOverlayWipPreserved: true
```

---

## Historical FAIL record (pre-16593bf)

Result: **FAIL**

This section preserves the earlier crash-fix / width / mount-blocker attempts.
It does not override the `16593bf` PASS above.

### Attempt

A fresh Pi 0.83 session opened the child overlay while the adapter composed a
header whose visible width was 115 columns. The host terminal width was 51.
Pi aborted before the retry/continue frozen-block interaction could finish.

```yaml
piVersion083: true
terminalWidth: 51
adapterLineWidth: 115
processAborted: true
nativeOverlayInteractionCompleted: false
retryContinueFrozenBlockObserved: false
```

No prompt text, transcript text, child id, parent session id, or native session
id is retained.

### Cleanup

After the abort, the verifier confirmed residual runtime surfaces were clear.

```yaml
residualRpcChildProcessCount: 0
runtimeStoreLeaseActive: false
extraPaneCreateSplitCloseCount: 0
```

### Verdict

**FAIL** — process aborted on over-wide overlay header (`adapterLineWidth=115`
at `terminalWidth=51`) before the frozen-block path could be exercised.

```yaml
currentResult: FAIL
sanitizedBlockerOutcome: overlay_render_width_assertion_abort
pendingFreshRerun: true
```

### Width-fixed rerun

A fresh narrow Pi 0.83 session used the trusted npm extension. The session was
ready, outside health-only mode, and owned the primary editor through pi-vim
before the overlay opened.

```yaml
piVersion083: true
ready: true
trusted: true
healthOnly: false
npmProvenance: true
unsafeOverrideAbsent: true
localExtensionShadowAbsent: true
piVimOwnedBeforeMount: true
installedExtensionSha256: eda2f6193544fee382a8447e20333eb95fa663cb3a510422f1c465c24fa30d84
extraPaneCreateSplitCloseCount: 0
```

#### Width regression

A bounded live child used a title longer than the available overlay header.
The native overlay opened in the narrow session and remained alive. Every
visible adapter line fit the render width. Empty Backspace closed the overlay,
and the child settled normally.

```yaml
terminalWidth: 51
longTitleOverlayOpened: true
liveOverlayObserved: true
visibleAdapterLineCount: 52
maxVisibleAdapterLineWidth: 51
overWidthAdapterLineCount: 0
processAliveAfterRender: true
widthFixtureOutcome: completed
primaryInputLeakObserved: false
piVimRestoredAfterClose: true
```

This directly clears the prior `overlay_render_width_assertion_abort` blocker.
The earlier crash record remains above as historical evidence.

#### Retry and continue blocker

The first cancellation observer stopped before sending keys because its wait
condition was brittle. Its bounded child completed safely, so it remained a
valid completed fixture.

A corrected observer started before the one permitted additional cancellation
child. It waited for that exact new native child record before using the
documented direct-child shortcut. The wait gate passed, but the active
pre-mount shortcut did not open the live overlay. The observer sent no
cancellation keys and stopped. The bounded child completed safely.

```yaml
firstCancellationKeysSent: false
firstCancellationFixtureOutcome: completed
correctedObserverStartedBeforeDispatch: true
newActiveChildWaitGateSatisfied: true
additionalCancellationChildCount: 1
activePreMountShortcutMounted: false
cancelKeysSent: false
cancelledOutcomeObserved: false
secondCancellationFixtureOutcome: completed
sanitizedBlockerOutcome: active_pre_mount_shortcut_failed
```

The stop condition prohibited another child or another mount attempt. Without
a real failed or cancelled run, retry was unavailable. Continue, frozen-block
hash comparison, divider ordering, lifecycle input isolation, and new-run
settlement were not attempted after the blocker.

```yaml
retryAttempted: false
continueAttempted: false
sameLogicalRetryThreadObserved: false
sameLogicalContinueThreadObserved: false
oldRunHashesCompared: false
runDividerOrderObserved: false
newRunSettlementObserved: false
lifecycleInputIsolationObserved: false
```

#### Rerun cleanup

```yaml
residualRpcChildProcessCount: 0
runtimeStoreActiveLeaseCount: 0
productionCodeChangeCount: 0
extraPaneCreateSplitCloseCount: 0
paneLeftOpen: true
```

### Historical verdict (superseded)

**FAIL** — the width regression is fixed, but Task 20(f) remained incomplete
until the `16593bf` PASS above because the corrected active pre-mount shortcut
did not open the newly observed child.

```yaml
currentResult: FAIL
widthRegressionFixed: true
sanitizedBlockerOutcome: active_pre_mount_shortcut_failed
pendingFreshRerun: true
```
