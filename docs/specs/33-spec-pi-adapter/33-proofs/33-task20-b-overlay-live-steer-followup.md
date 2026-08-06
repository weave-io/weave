# Task 20(b) — Full-screen overlay live tail, steering, and follow-up

Date: 2026-08-05

Result: **FAIL**

This proof covers only Task 20 matrix item (b). It records the observed blocker. It does not mark S043 or S044 complete.

## Pane and artifact

| Field | Value |
| --- | --- |
| Pane | `w23:p8V` |
| Pi version | `0.83.0` |
| Adapter package | `@weaveio/weave-adapter-pi@0.0.1` |
| Provenance | installed `npm:` package; package directory is not a symlink |
| Artifact | `.release/task20-refresh-6a547d315be90df7c5db2c3c764c922e74e5e024/out/weaveio-weave-adapter-pi-0.0.1.tgz` |
| Artifact SHA-256 | `e905209b8cf5359eb78c7c31c5ade4f82feaa660f752b3c45a8d07e62d41750d` |
| Installed extension SHA-256 | `7d441b86529a1d15baecb31a77a51f298f820eb73a4a927a366b493542d723bc` |
| Installed index SHA-256 | `925cc842591d9b8bd2ad9c94089e821eae2c26b641b89c04264f25cf0428213f` |
| Installed CLI SHA-256 | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |

## Provenance and readiness

The verifier inspected both live Pi processes without retaining environment values. Neither process had `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE`. The live pane showed the ready and trusted markers before the run. The installed package and settings confirmed `npm:` provenance.

```yaml
healthReady: true
statusTrusted: true
healthOnly: false
provenanceOverridePresentProcessCount: 0
livePiProcessCount: 2
npmPackageConfigured: true
packageDirectoryIsSymlink: false
```

## Attempts

### Attempt 1 — direct active-child shortcut

One ordinary, harmless, no-edit `shuttle-mini` delegation remained active long enough for overlay inspection. A sanitized driver sent the direct-child shortcut only to `w23:p8V` and sampled the visible viewport without retaining its text.

The native overlay did not open. The driver therefore did not enter or submit either draft. The child completed with structured evidence that it received neither intervention, and the delegation settlement reported zero interventions.

```yaml
overlayOpen: false
openAttempts: 30
outerPaneOffsetBefore: 0
outerPaneOffsetAfter: 0
liveDistinctViewportCount: 0
steerSeenByChild: false
followUpSeenByChild: false
interventionCount: 0
steerDraftSha256: 7e7ba4848d960a07e8f2bfb313c77688a8fae36eac1101d4ec8ab5a8be44c564
followUpDraftSha256: dee855bc1f6628aaee02aa95529b967b117e093e40e9230b77adee303ebb0bb9
```

### Attempt 2 — registered inspection command

Pi 0.83 documents that registered extension commands can execute during streaming. A second ordinary no-edit delegation tested that route. While the child was active, the driver entered the registered inspection command through the pane editor and submitted it.

The command did not open the inspector. Instead, a truncated command fragment reached the primary conversation as a new user submission. The child settled as cancelled and the driver aborted. The proof stores only the fragment length and hash.

```yaml
nativeOverlayOpened: false
childSettlementOutcome: cancelled
driverOutcome: aborted
primarySubmissionObserved: true
primarySubmissionBytes: 10
primarySubmissionSha256: b93d430586ae052a546ff3b63301930b6adb912e6e0c5ae77498e87341e43ef3
rawPrimarySubmissionStored: false
```

This is a fail-closed blocker for item (b): there was no safe route to the live native overlay in this pane, and the command route violated primary-editor isolation.

## Assertions

| Assertion | Result | Sanitized evidence |
| --- | --- | --- |
| Unsafe provenance override is absent | **PASS** | `0/2` live Pi processes contained the variable. |
| Pi 0.83 is ready and trusted | **PASS** | Ready/trusted UI markers and installed `npm:` package were present. |
| An ordinary long-enough child delegation runs | **PASS** | Attempt 1 completed; attempt 2 ran until the command-route blocker cancelled it. |
| Real native child overlay opens while the child is active | **FAIL** | Attempt 1: `overlayOpen=false`; attempt 2: `nativeOverlayOpened=false`. |
| Live tail updates in the full-screen overlay | **FAIL — not observed** | No native overlay opened; `liveDistinctViewportCount=0`. |
| Scroll disengages and End resumes live follow | **FAIL — not testable** | No native overlay opened. |
| Safe steering draft submits with Enter | **FAIL — not testable** | The overlay editor was unavailable. |
| Steering reaches the child | **FAIL** | Child evidence: `steerSeen=false`; settlement: `interventionCount=0`. |
| Safe follow-up draft submits with Alt+Enter | **FAIL — not testable** | The overlay editor was unavailable. |
| Follow-up reaches the child | **FAIL** | Child evidence: `followUpSeen=false`; settlement: `interventionCount=0`. |
| Overlay input stays isolated from the primary editor | **FAIL** | The inspection-command route produced a 10-byte primary submission; only its SHA-256 is retained. |
| Evidence stores no prompts or transcripts | **PASS** | Samplers emitted only booleans, counts, outcomes, and SHA-256 values; temporary drafts were deleted. |
| No child process remains | **PASS** | Pane-descendant inspection found zero `--mode rpc --no-session` Pi processes. |
| No Runtime Store lease remains | **PASS** | Runtime Store schema 5 reported `No active lease.` |
| No other pane was changed | **PASS** | All Herdr operations targeted only `w23:p8V`. |

## Final cleanup state

```yaml
childProcessRemaining: false
runtimeStoreLeaseActive: false
samplerRunning: false
temporaryDraftsPresent: false
cleanupPending: true
cleanupPendingReason: close only pane w23:p8V after the parent verification run consumes this proof
otherPanesAltered: false
```

Pane `w23:p8V` remains open. No other pane was changed or closed.

## Required follow-up

Do not mark Task 20(b), S043, or S044 complete from this run. Fix or provide a conflict-safe active-run route that opens the native child overlay while pi-vim owns the primary editor. Then rerun item (b) in a fresh pane and prove live tail, scroll disengagement/follow, Enter steering, Alt+Enter follow-up, primary-editor isolation, and clean settlement.

## Remediation (Task 21, source-side only)

Root cause: overlay shortcut registration required an injected keybindings
object, and the check that recognized one required `getEffectiveConfig()`.

- Pi's live `KeybindingsManager` (`@earendil-works/pi-tui`) exposes
  `getResolvedBindings()`, so the capture rejected every real host manager.
- The only injection points were Weave's composed editor factory and the
  overlay `ui.custom` factory. With `pi-vim` owning the primary editor, Weave
  yields and never installs its factory, and the overlay factory only runs
  after an overlay already opened. No shortcut could ever register.

Fix:

- `captureChildOverlayKeybindings` / `childOverlayConflictPortFromHost` accept
  `getResolvedBindings()` as well as `getEffectiveConfig()`.
- The inspection runtime takes a `hostKeybindings` port (production: Pi's
  public `getKeybindings()`), so conflict inspection no longer depends on
  editor ownership.
- Registration runs at session activation, before the editor factory is
  composed and regardless of whether Weave installs it, so `child_inspection`
  key overrides still apply. Raw keys are claimed once; the plan is rebuilt
  per generation. Keys already owned by the host or user are skipped and
  reported, never overwritten.

Status: unchanged. This is source-side remediation only. Task 20(b), S043, and
S044 stay incomplete until a fresh Herdr rerun proves the live behaviour.

---

## Fresh rerun — 2026-08-05

Result: **FAIL**

This rerun used one fresh Pi 0.83 pane and one controlled `shuttle-mini` child.
It preserves the prior failure history above. It does not mark Task 20(b), S043,
or S044 complete.

### Fresh prerequisite observations

```yaml
piVersion083: true
readyStatusObserved: true
trustedNpmPackageProvenance: true
healthOnly: false
npmPackageConfigured: true
packageDirectoryIsSymlink: false
primaryEditorOwnedByPiVim: true
unsafeProvenanceOverrideProcessCount: 0
livePiProcessCountChecked: 2
installedExtensionSha256: 480d83b90133d6a92e7e1cf6db701425a3679fe975a218ce161e7f76cf38016f
productionCodeChanged: false
controlledChildCount: 1
```

### Fresh controlled-run observations

The proof driver started before the child dispatch and exhausted its bounded
mount window as the child became active. The timestamps show only six seconds
of overlap. The driver sent the real Alt+1 shortcut 120 times, but it did not
observe a mounted overlay before its window ended. It therefore sent no draft
or intervention. The child then completed its 120 bounded progress events and
reported zero interventions.

```yaml
driverStartedAt: 2026-08-05T22:19:34.504061Z
childStartedAt: 2026-08-05T22:21:33Z
driverCompletedAt: 2026-08-05T22:21:39.480271Z
childCompletedAt: 2026-08-05T22:23:34Z
activeWindowOverlapSeconds: 6
overlayMountAttempts: 120
overlayMounted: false
liveTailDistinctBodyHashCount: 0
liveTailAdvanced: false
manualScrollDisengaged: false
manualScrollNewEntriesObserved: false
manualScrollAnchorStable: false
bottomReturnDistinctBodyHashCount: 0
bottomReturnResumedLiveTail: false
steeringSubmitted: false
followUpSubmitted: false
childSteeringObserved: false
childFollowUpObserved: false
interventionCount: 0
childProgressEventCount: 120
childSettlementOutcome: completed
settledOverlayObserved: false
settledReadOnlyObserved: false
driverOutcome: FAIL
driverErrorSha256: c6e7f8935ef29d301b096f93af0a05281fc11a9cb77f9d84403fe369ad099557
evidenceSha256: 8decd6ab7e0fa19490d825d0e66def009bb017ccc8efa1b4bbec46ea860d29a8
```

### Fresh assertion matrix

| Assertion | Result | Sanitized evidence |
| --- | --- | --- |
| Ready, trusted, non-health-only Pi 0.83 pane | **PASS** | All five prerequisite booleans were observed. |
| Unsafe provenance override is absent | **PASS** | `0/2` checked live Pi processes contained the override. |
| Required installed extension is active | **PASS** | Installed extension SHA-256 matched the required hash. |
| One controlled active child runs long enough | **PASS** | One child emitted 120 progress events and settled as completed. |
| Real Alt+1 mounts the native active-child overlay | **FAIL** | `overlayMounted=false` after 120 attempts in the bounded driver window. |
| Live tail advances | **FAIL — not observed** | `liveTailDistinctBodyHashCount=0`. |
| Manual scroll disengages without a viewport jump | **FAIL — not observed** | The overlay did not mount. |
| Returning to bottom resumes live-tail | **FAIL — not observed** | The overlay did not mount. |
| Enter submits steering | **FAIL — not observed** | `steeringSubmitted=false`. |
| Alt+Enter submits a follow-up | **FAIL — not observed** | `followUpSubmitted=false`. |
| Overlay input does not leak into the primary editor | **FAIL — not testable** | No overlay draft or intervention was entered. |
| The child observes both interventions | **FAIL** | Both observation booleans were false; intervention count was zero. |
| Settlement is clean | **PASS** | Child settlement completed and no Runtime Store lease remained. |
| Settled overlay is read-only | **FAIL — not observed** | `settledReadOnlyObserved=false`. |
| No production code or other pane changed | **PASS** | Production-change and other-pane-change counts were zero. |

### Fresh blocker and cleanup

The exact blocker is proof orchestration timing: the bounded driver had only six
seconds of active-child overlap and ended before it observed the overlay. This
rerun does not establish a product regression or validate the Task 21 remedy.
A new run must start the driver immediately before child dispatch, or give the
mount loop a window that begins only after the child is active.

```yaml
runtimeStoreLeaseActive: false
childProcessRemaining: false
driverRunning: false
otherPanesAlteredCount: 0
panesClosedCount: 0
cleanupOutcome: temporary_proof_files_removed
coordinatorCleanupTargetCount: 1
coordinatorCleanupTargetOutcome: close_current_proof_pane_when_no_longer_needed
```

---

## Fresh wait-gated rerun — 2026-08-05

Result: **FAIL**

This rerun used one fresh Pi 0.83 pane and exactly one controlled
`shuttle-mini` child. It preserves both earlier failed attempts. The driver
waited for a new active-child process signal before it sent any overlay key.
The run does not mark Task 20(b), S043, or S044 complete.

### Prerequisite observations

```yaml
piVersion083: true
readyStatusObserved: true
trustedNpmPackageProvenance: true
healthOnly: false
unsafeProvenanceOverrideAbsent: true
primaryEditorOwnedByPiVim: true
primaryPiVimStateBefore: INSERT
installedExtensionSha256: 480d83b90133d6a92e7e1cf6db701425a3679fe975a218ce161e7f76cf38016f
installedExtensionHashExact: true
productionCodeChanged: false
controlledChildCount: 1
```

### Wait-gated controlled-run observations

The driver observed the controlled child's active RPC process after 8.013
seconds. It sent zero overlay keys before that signal. It then sent the real
Alt+1 shortcut 120 times during a bounded 120-second mount window while the
child remained active. The native overlay did not mount. The child remained
active for about 375 progress events, received zero interventions, and settled
as completed. Thus, this run removed the prior six-second-overlap orchestration
error but directly reproduced an active-child Alt+1 mount failure.

```yaml
activeChildSignalObserved: true
activeChildSignalWaitMilliseconds: 8013
overlayKeyAttemptsBeforeActiveSignal: 0
activeChildRpcProcessCountAtSignal: 2
overlayMountAttemptsAfterActiveSignal: 120
overlayMountWindowSeconds: 120
overlayMounted: false
liveTailDistinctBodyHashCount: 0
liveTailAdvanced: false
manualScrollDisengaged: false
manualScrollNewEntriesObserved: false
manualScrollAnchorStable: false
bottomReturnDistinctBodyHashCount: 0
bottomReturnResumedLiveTail: false
steeringDraftByteCount: 0
steeringSubmitted: false
steeringReachedChild: false
followUpDraftByteCount: 0
followUpSubmitted: false
followUpReachedChild: false
childInterventionCount: 0
childProgressEventCountApproximate: 375
childSettlementOutcome: completed
settledOverlayObserved: false
settledReadOnlyObserved: false
piVimRestoredAfterUnmountObserved: false
primaryEditorLeakCheckObserved: false
primarySessionLeakCheckObserved: false
childProcessRemaining: false
runtimeStoreLeaseActive: false
driverOutcome: FAIL
driverBlockerOutcome: overlay_not_mounted_after_active_signal
driverErrorSha256: b3e12ed6011c1089599af110645a0800bfe3a9660ad488a3da5b624f7aafb85d
evidenceByteCount: 2146
evidenceSha256: 7593f359d304fb04c2383028ae065bb8b20fe51b065909f447c417e160c8fe00
```

### Wait-gated assertion matrix

| Assertion | Result | Sanitized evidence |
| --- | --- | --- |
| Required installed extension is active | **PASS** | The installed SHA-256 matched exactly. |
| Ready, trusted npm provenance, non-health-only Pi 0.83 | **PASS** | All prerequisite booleans were observed before dispatch. |
| Unsafe provenance override is absent | **PASS** | The live Pi process did not contain the override. |
| Pi-vim owns the primary editor | **PASS** | Pi-vim state was `INSERT` before dispatch. |
| Driver waits for an active child before Alt+1 | **PASS** | The signal arrived after 8.013 seconds; pre-signal key count was zero. |
| One controlled child provides enough active overlap | **PASS** | The child stayed active for about 375 progress events. |
| Real Alt+1 mounts the active-child overlay | **FAIL** | The overlay did not mount after 120 post-signal attempts. |
| Live tail advances | **FAIL — not observed** | No native overlay mounted. |
| Manual scroll disengages and the viewport stays fixed | **FAIL — not observed** | No native overlay mounted. |
| Returning to bottom resumes live tail | **FAIL — not observed** | No native overlay mounted. |
| Enter submits steering and the child receives it | **FAIL — not observed** | No overlay editor was available; intervention count was zero. |
| Alt+Enter submits follow-up and the child receives it | **FAIL — not observed** | No overlay editor was available; intervention count was zero. |
| Neither intervention leaks into the primary editor or session | **FAIL — not testable** | No draft or intervention was entered. |
| Settlement is clean | **PASS** | Settlement completed with no child process and no active lease. |
| Settled overlay is read-only | **FAIL — not observed** | No overlay mounted. |
| Pi-vim state returns after unmount | **FAIL — not testable** | No overlay mounted, so no unmount occurred. |
| No production code or other pane changed | **PASS** | Change and close counts were zero. |

### Exact blocker and cleanup

The exact sanitized blocker is
`overlay_not_mounted_after_active_signal`: after the active-child signal, the
real Alt+1 shortcut did not mount the native overlay during 120 attempts and a
120-second active overlap. Because the overlay never mounted, every required
interaction assertion after mount remains unproved. The result is **FAIL**.

```yaml
runtimeStoreLeaseActive: false
childProcessRemaining: false
driverRunning: false
otherPanesAlteredCount: 0
panesClosedCount: 0
coordinatorCleanupTargetCount: 2
coordinatorCleanupTargets:
  - current_proof_pane_when_no_longer_needed
  - temporary_proof_artifacts_after_commit_verification
```

---

## Source remediation — live unreadable initial page (2026-08-05)

Result: **FAIL** (source-side only; Herdr item (b) still required)

Root cause of the active-child Alt+1 mount failure after Task 21 shortcut
registration: `ChildOverlayController.open` required a readable historical
newest page before mounting. A live `weave_delegate` child often has no
readable thread/session page yet, so open returned `fallback-required` and the
extension handed off to custom-editor inspection, which borrows the primary
editor from whoever owns it (`pi-vim`). That path never mounts the native
`ui.custom` overlay.

Fix:

The page-reader and source layers now distinguish a transient startup gap
from a wiring or integrity defect.

Exact boundary (`readOverlaySessionEntryPage` in `extension.ts`, then
`mapNativePageError` / controller recovery in `child-overlay.ts` /
`child-overlay-controller.ts`):

- A resolved child with no session reference returns an empty initial page
  (`entries: []`) without consulting session infrastructure.
- An absent controller, a child-resolution failure, or a missing session
  source / `readSessionEntryPage` API for a child that already has a session
  ref fails closed as unreadable (`SessionCorrupt` reason `unreadable`).
  Those conditions do **not** emit `SourceStartupNotReady`.
- Only a native `SessionMissing` raised while reading a session ref the
  resolved child already claims maps to `SourceStartupNotReady`. Permission
  errors, root violations, malformed or missing headers, parent-session
  mismatch, and every other corruption still map to `SourceCorrupt`.
- The overlay controller recovers from `SourceStartupNotReady` only while
  child `status === "live"`: open an empty native live-tail page
  (`entries: []`, `liveTail: true`) and fill from the live event stream.
- Every other live failure (`SourceCorrupt`, `SourceUnavailable`,
  `SourceInvalidCursor`, `ChildNotFound`) keeps the fail-closed
  `source-failed` fallback.
- Settled, orphaned, and unknown children keep the fail-closed fallback even
  for `SourceStartupNotReady`.

Unit coverage:

- Page reader: no session ref → empty page, sessions unread; absent
  controller / unresolved child / missing session source or read API for a
  known ref → unreadable fail-closed; native `SessionMissing` for a known
  ref preserved for source mapping.
- Source: native `SessionMissing` → `SourceStartupNotReady`; permission,
  root violation, missing header, parent-session mismatch, and unreadable →
  `SourceCorrupt`.
- Controller: live + startup-not-ready → empty page + later live event
  renders; live + each hard source error → `fallback-required`; non-live +
  startup-not-ready → `fallback-required`; settled unreadable source →
  `fallback-required`.
- Extension: real `weave_delegate` dispatch, registered Alt+1, native overlay
  mount while pi-vim retains primary editor ownership.

Status: unchanged for Task 20(b), S043, and S044. A fresh Herdr pane must still
prove live tail, scroll disengage/follow, Enter steering, Alt+Enter follow-up,
primary-editor isolation, and clean settlement.

## Post-fix rerun — overlay-startup-fix artifact (2026-08-06)

### Scope and safety

This rerun executed matrix item **(b) only** against the newly installed
artifact. It made zero production-code edits and dispatched exactly one
bounded `shuttle-mini` child. The wait-gated driver sent zero keys before its
active-child gate. Evidence below contains only booleans, counts, timings,
outcomes, and SHA-256 values.

### Fresh Pi and artifact checks

| Check | Result | Sanitized observation |
| --- | --- | --- |
| Pi version | **PASS** | `0.83.0` |
| Adapter ready | **PASS** | A fresh no-session TUI directly rendered adapter mode `ready`. |
| Trusted | **PASS** | The configured `npm:` package loaded without an untrusted warning, and the bounded delegation was accepted. |
| Non-health-only | **PASS** | The fresh health view directly rendered adapter mode `ready`; mutating delegation was available and completed. |
| Npm provenance | **PASS** | The Weave adapter and pi-vim were configured as `npm:` packages; project extension count was `0`; local Weave shadow count was `0`. |
| Unsafe override absent | **PASS** | Matching launcher/config file count was `0`; the fresh Pi process had no override variable. |
| pi-vim ownership | **PASS** | The primary editor state was `INSERT` before dispatch and in the fresh verification TUI. |
| Installed extension hash | **PASS** | `ac1d12c298300741140d1cefa0e6946489e2fa8a5aeded2873f4c1ea07313061` |

### Wait gate and bounded child

```yaml
childDispatchCount: 1
initialActiveChildCount: 0
keysSentBeforeActiveGate: 0
activeChildObservedByGate: false
overlayKeysSent: 0
childSeparateCommandCount: 155
childElapsedAtLeast120Seconds: true
childSteeringObserved: false
childFollowUpObserved: false
childEditsMade: false
childOutcomeCompleted: true
childInterventionCount: 0
activeRuntimeLeaseCountAfterSettlement: 0
primaryUserMessageCountBefore: 1
primaryUserMessageCountAfter: 1
```

The driver reached `READY` before dispatch. It then waited for a new active
child and sent no keys. The single child ran for at least 120 seconds and
completed 155 separate read-only commands, but the gate never reported an
active child. The driver therefore exited before Alt+1, as required by its
fail-closed gate.

Exact sanitized blocker:

```text
wait_gate_did_not_observe_new_active_child
```

### Required assertion matrix

| Required assertion | Result | Direct observation |
| --- | --- | --- |
| Alt+1 mounts native active-child overlay | **NOT OBSERVED** | The active-child gate stayed false, so Alt+1 count was `0`. |
| Live tail advances | **NOT OBSERVED** | Native overlay did not mount. |
| Manual scroll disengages tail | **NOT OBSERVED** | Native overlay did not mount. |
| New entries preserve the manual anchor | **NOT OBSERVED** | Native overlay did not mount. |
| Return to bottom resumes tail | **NOT OBSERVED** | Native overlay did not mount. |
| Enter steering reaches child | **FAIL** | Child reported `steeringObserved: false`; intervention count was `0`. |
| Alt+Enter follow-up reaches child | **FAIL** | Child reported `followUpObserved: false`; intervention count was `0`. |
| No primary draft/key/submission leak | **NOT OBSERVED** | Primary user-message count stayed `1`, but no overlay draft or submission probe ran. |
| Clean settlement | **PASS** | Child completed; active runtime lease count was `0`; remaining child process count was `0`. |
| Settled overlay is read-only | **NOT OBSERVED** | Native overlay did not mount. |
| Unmount restores pi-vim | **NOT OBSERVED** | No overlay was mounted or unmounted. |

### Current overall result

**FAIL** — not every required assertion was directly observed. The exact
blocker is `wait_gate_did_not_observe_new_active_child`. Preserve Task 20(b),
S043, and S044 as incomplete.

## One-pane post-fix rerun — direct Alt+1 loop, no RPC gate

This rerun used only the requested fresh current pane. It did not create,
split, launch, or close another pane, and it did not launch a nested Pi
process. It made no production-code edits. The driver started Alt+1 attempts
12 seconds after the ready footer was observed and did not wait for RPC process
discovery. Exactly one controlled `shuttle-mini` child was dispatched.
Evidence below contains only booleans, counts, timings, outcomes, and hashes.

### Fresh Pi and artifact checks

```yaml
requestedCurrentPaneMatched: true
piVersion083: true
readyFooterObserved: true
trustedNpmProvenance: true
healthOnlyFalse: true
piVimInsertObservedBeforeDispatch: true
weaveNpmPackageConfigured: true
piVimNpmPackageConfigured: true
projectExtensionCount: 0
localWeaveShadowCount: 0
unsafeOverridePresentInSettings: false
unsafeOverridePresentProcessCount: 0
liveProcessEnvironmentCheckCount: 2
installedExtensionSha256: ac1d12c298300741140d1cefa0e6946489e2fa8a5aeded2873f4c1ea07313061
nestedPiLaunchCount: 0
paneCreateSplitCloseCount: 0
```

The live current-pane footer showed `Connected`, `ready`, and the active Weave
agent before dispatch. The pi-vim state was `INSERT`. The adapter and pi-vim
were both configured with `npm:` provenance, no project or local adapter shadow
was present, and both current-pane foreground process environments lacked the
unsafe override.

### Driver and controlled child

```yaml
childDispatchCount: 1
childOutcomeCompleted: true
childInterventionCount: 0
childElapsedSeconds: 150
childEmittedLineCount: 75
childSteeringObserved: false
childFollowUpObserved: false
driverPostReadyDelaySeconds: 12
driverMountTimeoutSeconds: 180
alt1AttemptCount: 161
alt1StoppedOnMount: false
overlayMounted: false
driverFailureElapsedMs: 192448
driverStderrByteCount: 0
readyViewportSha256: 77d38e394b05e3c50fda0825e37d785d10090683ec0801eaef083d15cacd30a7
postRunFooterSha256Prefix: b16283914ca2e4c7
```

The driver began its Alt+1 loop after the fixed 12-second delay. It continued
until the 180-second mount timeout and stopped after 161 attempts. No native
overlay mounted. The child stayed active for 150 seconds, emitted 75 timed
lines, and settled as `completed`. Since the overlay never mounted, the driver
correctly did not send either mutation message. The child directly reported
both observation booleans as false.

Exact sanitized blocker:

```text
native_overlay_mount_timeout_after_161_alt1_attempts
```

### Required assertion matrix

| Required assertion | Result | Direct observation |
| --- | --- | --- |
| Alt+1 mounts native active-child overlay | **FAIL** | The no-gate driver sent 161 Alt+1 attempts during the active child and observed no native overlay before the 180-second timeout. |
| Live tail advances | **NOT OBSERVED** | Native overlay did not mount. |
| Manual scroll disengages tail | **NOT OBSERVED** | Native overlay did not mount. |
| New entries preserve the manual anchor | **NOT OBSERVED** | Native overlay did not mount. |
| Return to bottom resumes tail | **NOT OBSERVED** | Native overlay did not mount. |
| Enter steering reaches child | **FAIL** | Overlay input was unavailable; no steering submission occurred, and the child reported false. |
| Alt+Enter follow-up reaches child | **FAIL** | Overlay input was unavailable; no follow-up submission occurred, and the child reported false. |
| No primary draft/key/submission leak | **NOT OBSERVED** | No overlay draft or submission probe could run. The post-run footer had no queued-message indicator, but that alone does not prove full isolation. |
| Clean settlement | **PASS** | The single child returned the host settlement outcome `completed` with zero interventions. |
| Settled overlay is read-only | **NOT OBSERVED** | Native overlay did not mount. |
| Closing overlay restores pi-vim `INSERT` | **NOT OBSERVED** | No overlay mounted, so no overlay close transition existed to test. |

### One-pane post-fix rerun result

**FAIL** — every criterion was not directly observed. The exact blocker is
`native_overlay_mount_timeout_after_161_alt1_attempts`. Keep Task 20(b), S043,
and S044 incomplete. Cleanup targets are the temporary background-driver
artifacts only; the requested pane remains open.

---

## Public terminal-input fix rerun — 2026-08-06

Result: **FAIL**

This rerun targeted only the owned current pane and requested exactly one
bounded `shuttle-mini` child. The sole child process exited before settlement
and returned no resumable thread identifier. A second child was not started.
The real-harness scenario therefore did not begin, and Task 20(b), S043, and
S044 remain incomplete.

### Prerequisite and dispatch outcomes

```yaml
requestedCurrentPaneMatched: true
requestedPaneOpen: true
sourceCommitExact: true
sourceCommit: 2eae427c7e65366cbdf9db84b9cd4e1d7a4d33b0
piVersion083: true
trustedNpmPackageConfigured: true
packageDirectoryIsSymlink: false
artifactHashMatchCount: 1
artifactSha256: 2870934901cd0b824e7c101379a72c9a37488497618eca839ca624878411318d
installedExtensionSha256: 8dbc032fa3d7a21aad16ffa39062ef32f4dbde2bde8e493fe3386e43b6364845
liveCurrentPiProcessChecked: true
unsafeOverridePresentInLiveCurrentPi: false
readyObserved: true
healthOnlyTrueObserved: false
piVimInsertObserved: false
boundedChildDispatchCount: 1
boundedChildActiveObserved: false
boundedChildSettled: false
boundedChildOutcome: ChildExitedUnexpectedly
resumableThreadIdentifierPresent: false
secondChildDispatchCount: 0
nestedPiLaunchCount: 0
otherPaneInspectCount: 0
otherPaneCreateSplitLaunchCloseCount: 0
```

### Required assertion matrix

| Required assertion | Result | Sanitized outcome |
| --- | --- | --- |
| Pi 0.83, exact source and artifact, strict trusted npm provenance | **PASS** | All exact version, source, provenance, and SHA-256 checks matched. |
| Unsafe override is absent from the live current Pi process | **PASS** | `unsafeOverridePresentInLiveCurrentPi=false`. |
| Ready and not health-only | **PASS** | `readyObserved=true`; `healthOnlyTrueObserved=false`. |
| Pi-vim starts in `INSERT` | **FAIL — not observed** | `piVimInsertObserved=false` during the active primary run. |
| One bounded child becomes active | **FAIL** | The only child exited before active-state evidence or settlement. |
| Alt+number mounts one native overlay and dispatches one action | **FAIL — not run** | `overlayMountCount=0`; `actionDispatchCount=0`. |
| Live tail advances | **FAIL — not run** | `liveTailAdvanceCount=0`. |
| Manual scroll disengages and preserves its anchor | **FAIL — not run** | `manualScrollProbeCount=0`. |
| End restores live follow | **FAIL — not run** | `endFollowProbeCount=0`. |
| Enter steering reaches only the child | **FAIL — not run** | `steeringSubmissionCount=0`; `steeringChildReceiptCount=0`. |
| Alt+Enter follow-up reaches only the child | **FAIL — not run** | `followUpSubmissionCount=0`; `followUpChildReceiptCount=0`. |
| Settled overlay becomes read-only | **FAIL — not run** | `settledOverlayProbeCount=0`. |
| Overlay close restores the primary editor and pi-vim state | **FAIL — not run** | `overlayCloseCount=0`; `restoreProbeCount=0`. |
| Ordinary input and plain Escape pass through | **FAIL — not run** | `passThroughProbeCount=0`. |
| No duplicate dispatch occurs | **FAIL — not testable** | No action dispatch occurred. |
| Listener teardown and reload are safe | **FAIL — not run** | `lifecycleReloadProbeCount=0`. |
| No prompt or transcript evidence is stored | **PASS** | Stored evidence contains only booleans, counts, hashes, and outcomes. |

### Exact blocker and cleanup

The exact sanitized blocker is
`sole_child_exited_before_settlement_without_resumable_thread_id`. Starting a
replacement child would have violated the one-child bound, so the rerun failed
closed without sending overlay or editor input.

```yaml
childRpcProcessCountAfterFailure: 0
runtimeStoreLeaseActiveAfterFailure: false
temporaryProofFileCountAfterFailure: 0
sourceChangeCountBeforeProofEdit: 0
otherPanesAlteredCount: 0
panesClosedCount: 0
requestedPaneLeftOpen: true
cleanupOutcome: clean
```
