# Task 20(b) — Full-screen overlay live tail, steering, and follow-up

Date: 2026-08-06

Result: **PASS**

Checklist version `3`. Latest targeted rerun attempt `9` against exact subject `16593bf` continued the same persisted item-(b)/(c) shuttle-mini thread after attempt `8` (entries 344→356). Manual scroll used Herdr semantic `shift+up` / `shift+down`. The `16593bf` anchor fix kept body hash / older marker / effective scroll stable while native entries and the newer-lines cue advanced under manual scroll. Item (c) separately proves absolute oldest/newest three-page pagination; this item does not re-claim that surface. Plan checkbox not marked.

This file preserves earlier FAIL history below and records the `16593bf` Continue live-anchor PASS.

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

---

## Second public terminal-input fix rerun — 2026-08-06

Result: **FAIL**

This rerun used only the fresh owned pane `w23:p9X`. It dispatched exactly one
bounded, read-only `shuttle` child and started one same-pane driver before the
dispatch. The driver used a fixed 18-second delay and sent exactly one real
Alt+1 shortcut. No replacement child was started.

The sole child finished without a terminal assistant response. The host
returned `ChildResponseMissing` with reason `tool-only`. The driver sent the
single shortcut 18.033 seconds after it started, but observed no native overlay.
The driver therefore sent no steering or follow-up draft and performed no
post-mount mutation. A single real `/reload` attempt was also bounded and failed
closed with `Wait for the current response to finish before reloading.` It did
not execute generation teardown, so listener teardown and fresh-listener
behavior remain unproved.

### Exact artifact, provenance, and readiness

```yaml
requestedCurrentPaneMatched: true
requestedPane: w23:p9X
piVersion: 0.83.0
expectedSourceCommit: 2eae427c7e65366cbdf9db84b9cd4e1d7a4d33b0
artifactHashMatchCount: 1
artifactSha256: 2870934901cd0b824e7c101379a72c9a37488497618eca839ca624878411318d
installedExtensionSha256: 8dbc032fa3d7a21aad16ffa39062ef32f4dbde2bde8e493fe3386e43b6364845
trustedNpmSettingCount: 1
packageDirectoryIsSymlink: false
localExtensionShadowCount: 0
livePiAncestryProcessCountChecked: 2
unsafeOverridePresentProcessCount: 0
readyObserved: true
healthOnlyTrueObserved: false
piVimInsertObserved: true
nestedPiSessionLaunchCount: 0
otherPaneInspectCount: 0
otherPaneCreateAlterCloseCount: 0
```

### Driver and lifecycle outcomes

```yaml
driverStartedBeforeDispatch: true
fixedPostDispatchDelayMs: 18000
observedShortcutDelayMs: 18033
altNumberShortcutCount: 1
boundedChildDispatchCount: 1
secondChildDispatchCount: 0
childTerminalResponseObserved: false
childOutcome: ChildResponseMissing
childOutcomeReason: tool-only
overlayMountCount: 0
actionDispatchCount: 0
liveTailDistinctViewportHashCount: 0
liveTailAdvanced: false
manualScrollProbeCount: 0
endFollowProbeCount: 0
steeringSubmissionCount: 0
followUpSubmissionCount: 0
steeringPrimaryUserMessageCount: 0
followUpPrimaryUserMessageCount: 0
settledOverlayProbeCount: 0
overlayCloseCount: 0
ordinaryInputPassedThrough: true
plainEscapePassedThrough: true
piVimInsertRestoredAfterEscape: true
reloadCommandCount: 1
reloadExecuted: false
reloadOutcome: blocked_current_response
listenerTeardownObserved: false
freshListenerDispatchObserved: false
driverMetricSha256: 0cf96b70d8409c515ec29e63d13b3714331950cf4b7085b22593e591d732b036
rawCaptureFileCount: 0
```

### Required assertion matrix

| Required assertion | Result | Sanitized outcome |
| --- | --- | --- |
| Pi 0.83 and the exact installed artifact | **PASS** | Version, artifact SHA-256, and installed extension SHA-256 matched. |
| Trusted npm provenance with no unsafe live-process override | **PASS** | One npm setting, no local shadow or symlink, and `0/2` checked live processes had the override. |
| Ready, not health-only, and pi-vim active | **PASS** | The owned viewport showed `ready`, `WEAVE · LOOM`, and `INSERT`; no health-only marker appeared. |
| Exactly one bounded real child | **PASS** | Dispatch count was `1`; replacement count was `0`. |
| The child emits enough timed events and settles cleanly | **FAIL** | The child returned no terminal assistant response: `ChildResponseMissing`, reason `tool-only`. |
| One Alt+number input causes one native overlay mount/action | **FAIL** | One Alt+1 was sent after 18.033 seconds; mount and action counts were both `0`. |
| Live tail advances | **FAIL — not observed** | No overlay mounted. |
| PageUp disengages follow and preserves its anchor | **FAIL — not observed** | No overlay mounted; probe count was `0`. |
| End resumes live follow | **FAIL — not observed** | No overlay mounted; probe count was `0`. |
| Enter steering reaches only the child | **FAIL — not observed** | Fail-closed driver sent no draft; child and primary receipt counts were `0`. |
| Alt+Enter follow-up reaches only the child | **FAIL — not observed** | Fail-closed driver sent no draft; child and primary receipt counts were `0`. |
| Drafts, keys, and submissions do not leak to the primary | **FAIL — only partial evidence** | No draft was sent and primary user-message counts stayed `0`; mounted-overlay isolation was not testable. |
| Settlement is clean | **FAIL** | No terminal child response or settled-overlay state was observed. |
| Settled overlay is read-only | **FAIL — not observed** | No overlay mounted. |
| Closing restores primary input and pi-vim | **FAIL — not observed** | No overlay mounted, so no close transition existed. |
| Ordinary input and plain Escape pass through | **PASS** | Ordinary input reached the primary editor; plain Escape reached pi-vim `NORMAL`, and `i` restored `INSERT`. |
| Reload tears down the old listener without duplicate dispatch | **FAIL** | Pi refused the one bounded reload during the active response; teardown did not execute. |
| No raw prompt, transcript, or draft is stored | **PASS** | Repository evidence contains only booleans, counts, hashes, timings, and outcomes. |

### Exact blockers and cleanup

The exact sanitized blockers are
`child_response_missing_tool_only`,
`overlay_not_mounted_after_one_alt1_at_18033ms`, and
`reload_blocked_while_current_response_active`. Task 20(b), S043, and S044
remain incomplete, and the canonical result remains **FAIL**.

```yaml
childRpcProcessCountAfterFailure: 0
runtimeStoreSchemaVersion: 5
runtimeStoreActiveLeaseCount: 0
sourceChangeCountBeforeProofEdit: 0
otherPanesAlteredCount: 0
panesClosedCount: 0
requestedPaneLeftOpen: true
temporaryProofFileCountAfterCleanup: 0
cleanupOutcome: clean
```

---

## 47ae0fd isolated-harness attempt 5 — Herdr Shift+Up/Down — 2026-08-06

Result: **FAIL**

Checklist version `3`. Matrix item `(b)` after `fix(pi): route raw scroll input to the child overlay`. Run attempt `5` against exact subject `47ae0fd` in `$HOME/.local/share/weave/task20-pi083-harness`. Manual overlay scroll used Herdr `shift+up` / `shift+down` because Herdr 0.8 reserves plain PageUp/PageDown for pane scrollback (S043 requires manual scroll, not a specific key). pi-vim was disabled for this item only (restored after cleanup). Hard limit 8 minutes. No commit (PASS-only commit gate).

### Subject and artifact

| Field | Verified value |
| --- | --- |
| Subject HEAD | `47ae0fdd61ccc37834a696f32ebfb21052ae0752` |
| Host Pi in pane | `0.83.0` via `$ISO/shim/pi` |
| Global Pi (untouched) | `0.84.0` |
| Artifact | `$ISO/pi-agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-47ae0fd-task20iso-f091dd85b1a8.tgz` |
| Artifact SHA-256 | `f091dd85b1a82ce3c58a22a816e4699bbdd3300738e25c7520ccff3cb5f52f51` |
| Installed `dist/extension.js` | `48a9d75811928c03b2bbdbaa6d936c2297de13d096995f3f2e2d6eb2695e7823` |
| Installed `dist/index.js` | `7e6f94708501daf8108255dacc23edfbfd5332a57efa58703f080390d0218a1f` |
| Installed `dist/cli.js` | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |
| Provenance | `npm:@weaveio/weave-adapter-pi` (not a symlink); package directory is not a symlink |
| Packages during run | `npm:@weaveio/weave-adapter-pi` only (pi-vim removed for this item) |
| `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` | unset in launcher and live ISO processes (`0` override) |
| Local extension shadow | absent under `$ISO/pi-agent/extensions` |
| Host | `joses-Apple-MacBook-Pro` |
| Pane / agent | `w23:pB7` / `task20b5` |
| Run id / markers | `423DFAA4` (`TASK20B_OLD/MID/NEW/STEER/FOLLOW/PASS_423DFAA4`) |
| Active child id from status gate | `326295f9-e67c-45ae-ad1d-09fb47713588` |
| `childSettlementMissingCount` | `0` |

### Environment

```yaml
readyStatusObserved: true
trust: trusted
healthOnly: false
piVimDisabled: true
nativeOverlayMountRoute: alt+i+enter
nativeCustomComponentMounted: true
customEditorFallbackObserved: false
statusGateObserved: true
statusChildrenCount: 1
manualScrollKey: herdr_shift+up
manualScrollDownKey: herdr_shift+down
shiftUpAccepted: true
shiftDownAccepted: true
pageUpPageDownNote: herdr_0.8_pane_scrollback_conflict_not_proven_overlay_path
herdrNamedPageUpSupported: false
herdrHomeEndSendKeysOnLivePane: unsupported_invalid_key
liveWindow: 2026-08-06T21:30:59Z .. 2026-08-06T21:38:35Z
```

Mount used one status-gated picker selection (`Alt+I` then Enter) after compact `shuttle-mini · running` and one `/weave:status` showing `children: 1`. No blind Alt+1 loop. Plain PageUp/PageDown were not used as the overlay proof keys and are not claimed to have reached Pi.

### Controlled-run observations (attempt 5)

```yaml
overlayMountAttempts: 1
overlayMounted: true
overlayMountedLive: true
nativeCustomComponentMounted: true
steeringSubmitted: true
steeringReachedChild: true
followUpSubmitted: true
followUpReachedChild: true
primaryEditorSteeringLeak: false
primaryEditorFollowUpLeak: false
primaryDraftSeededBeforeMount: true
liveTailDistinctBodyHashCount: 1
liveTailAdvanced: false
newMarkerSeenExact: true
oldMarkerSeenExact: false
midMarkerSeenExact: false
shiftUpKeyCount: 300
shiftUpReachedOldest: false
manualScrollDisengaged: false
manualScrollInitialNewerCount: null
manualScrollNewEntriesObserved: false
manualScrollAnchorStable: false
shiftDownTraversedNewer: true
newerCueDecreased: false
newerCueDisappearedAtBottom: true
endResumedLiveTail: true
bottomReturnDistinctBodyHashCount: 2
settledObserved: false
settledReadOnlyObserved: false
settledStillScrollable: false
overlayClosedAfterProof: false
primaryDraftPreservedAfterClose: false
childRpcProcessCountAtEnd: 0
remainingSecondsAtEnd: 24.1
outcome: FAIL
driverBlockerOutcome: failed:liveTailAdvanced,oldMarkerSeenExact,shiftUpReachedOldest,newerCueDecreased,manualScrollDisengaged,manualScrollNewEntriesObserved,manualScrollAnchorStable,primaryDraftPreservedAfterClose,settledObserved,settledReadOnlyObserved,settledStillScrollable,overlayClosedAfterProof
```

### Assertion matrix

| Assertion | Result | Sanitized evidence |
| --- | --- | --- |
| Pi 0.83 + exact `47ae0fd` npm artifact; unsafe override absent | **PASS** | Version, artifact, installed digests matched tarball; override unset |
| One real `shuttle-mini` child streams with unique markers | **PASS** | Child id `326295f9-…`; NEW marker observed; `childSettlementMissingCount: 0` |
| Status-gated open mounts native `◆ … · LIVE` custom overlay | **PASS** | `overlayMountRoute=alt+i+enter`; `nativeCustomComponentMounted=true`; no custom-editor fallback |
| Herdr `shift+up` accepted/forwarded; disengages live-tail; older markers + newer-lines cue | **FAIL** | `shiftUpAccepted=true` after 300 keys; Herdr pane scroll offset unchanged (not stolen as scrollback); `manualScrollDisengaged=false`; `oldMarkerSeenExact=false`; cue never appeared |
| Herdr `shift+down` reduces newer cue; End clears cue and follows later output | **FAIL** | `shiftDownAccepted=true`; `newerCueDecreased=false` (no cue to reduce). Herdr `home`/`end` send-keys returned `invalid_key` on the live pane, so End was not a proven overlay delivery path |
| Manual scroll keeps viewport anchor while later output arrives | **FAIL** | `manualScrollNewEntriesObserved=false`; `manualScrollAnchorStable=false` |
| Enter steering + Alt+Enter follow-up reach child once each | **PASS** | Both submitted and observed; no primary-editor token leak |
| Closing overlay restores pre-seeded primary draft | **FAIL** | `primaryDraftSeededBeforeMount=true`; `primaryDraftPreservedAfterClose=false` |
| Settled overlay scrollable/read-only; compact freeze | **FAIL — not observed** | `settledObserved=false` before hard-limit exit; overlay remained `LIVE` |
| Cleanup: no rpc child / lease; created pane closed; WIP preserved | **PASS** | ISO rpc `0`; Runtime Store schema 5 `No active lease.`; pane `w23:pB7` closed; unrelated overlay WIP SHA-256 baseline unchanged |

### Repository checks (detached `47ae0fd` worktree)

| Check | Result |
| --- | --- |
| Focused raw-terminal / overlay / inspection tests | **138 pass**, 0 fail |
| `bun run docs:check-links` | PASS |

### Exact blocker and notes

Exact sanitized blocker:

```text
failed:liveTailAdvanced,oldMarkerSeenExact,shiftUpReachedOldest,newerCueDecreased,manualScrollDisengaged,manualScrollNewEntriesObserved,manualScrollAnchorStable,primaryDraftPreservedAfterClose,settledObserved,settledReadOnlyObserved,settledStillScrollable,overlayClosedAfterProof
```

Center of failure: after native LIVE mount and successful steer/follow, Herdr `shift+up` was accepted and did not move Herdr pane scrollback, but the mounted overlay never showed a positive newer-lines cue or OLD/MID markers. Post-run visible overlay content contained recent NEW/PROGRESS lines only (no FILL/OLD), so the live window had no proven scroll extent. Close/draft restore and settled read-only checks therefore did not complete inside the 8-minute window.

Attempt 4 used raw PTY PageUp and is superseded for the scroll-key claim. Attempt 5 proves the conflict-safe Herdr key path is accepted, but not that the overlay consumed it for manual scroll. Plain PageUp/PageDown remain a Herdr pane-scrollback conflict and are not claimed to have reached Pi.

Pre-existing panes at start: `w23:p79 w23:p70`. This run closed only created pane `w23:pB7`. Remaining: `w23:p79 w23:p70`. Isolated settings restored to include `npm:pi-vim` after the run. Temporary worktree removed. No proof commit.

```yaml
childProcessRemaining: false
runtimeStoreLeaseActive: false
createdPaneClosed: true
proofCommitted: false
planCheckboxMarked: false
unrelatedOverlayWipPreserved: true
```


---

## 08e3ee5 isolated-harness attempt 6 — Continue 138-entry child — 2026-08-06

Result: **FAIL**

Checklist version `3`. Matrix item `(b)` against exact subject `08e3ee5` in `$HOME/.local/share/weave/task20-pi083-harness`. Reused the item-(c) settled 138-entry / three-page native fixture (`nativeSessionDigestSha256` `b6984f89…` before Continue). Parent session resumed; `weave_delegate` `action=continue` started a distinct live attempt on the same thread. Manual overlay scroll used Herdr `shift+up` / `shift+down`. pi-vim disabled for this item only and restored after cleanup. Hard limit 8 minutes. No commit (PASS-only commit gate). Plan checkbox not marked.

### Subject and artifact

| Field | Verified value |
| --- | --- |
| Subject HEAD | `08e3ee52a9560cc85b822f23a82d56c47328d33d` |
| Host Pi in pane | `0.83.0` via `$ISO/shim/pi` |
| Global Pi (untouched) | `0.84.0` |
| Artifact | `$ISO/pi-agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-08e3ee5-task20iso-39c5ef0f80f6.tgz` |
| Artifact SHA-256 | `39c5ef0f80f6da4f6e022e992b0c48b0e6faef0cb8536b1b74fe0e375b4ab177` |
| Installed `dist/extension.js` | `8ba4c83e74b48262258d0fbee7bddb379240d92f0b2ebb5adf88e000a456104d` |
| Installed `dist/index.js` | `e28e5d165b2ea706ea71d676c77e7a3f526dfa332b283d019e96eebe812ade48` |
| Installed `dist/cli.js` | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |
| Tarball vs installed digests | match |
| Provenance | `npm:@weaveio/weave-adapter-pi` (not a symlink) |
| Packages during run | `npm:@weaveio/weave-adapter-pi` only (pi-vim removed for this item) |
| `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` | unset in launcher and live ISO process |
| Local extension shadow | absent under `$ISO/pi-agent/extensions` |
| Host | `joses-Apple-MacBook-Pro` |
| Pane / agent | `w23:pBJ` / `task20bc6` |
| Run id / markers | `5C9B8796` (`TASK20B_LIVE/STEER/FOLLOW/PASS_5C9B8796`; historical `TASK20C_*_8BCAA12E`) |
| Continued thread | same item-(c) shuttle-mini thread (identity not retained here) |
| Native entries before → after | `138` → `196` |
| `childSettlementMissingCount` | `0` |

### Environment and Continue

```yaml
readyStatusObserved: true
trust: trusted
healthOnly: false
piVimDisabled: true
continueUsed: true
nativeOverlayMountRoute: alt+i+enter
nativeCustomComponentMounted: true
customEditorFallbackObserved: false
statusGateObserved: true
manualScrollKey: herdr_shift+up
manualScrollDownKey: herdr_shift+down
expectedShiftUpBytes: "\x1b[1;2:1A"
closeDelivery: empty_backspace
```

### Controlled-run observations (attempt 6)

```yaml
overlayMounted: true
overlayMountedLive: true
liveTailDistinctBodyHashCount: 5
liveTailAdvanced: true
steeringSubmitted: true
steeringReachedChild: true
followUpSubmitted: true
followUpReachedChild: true
primaryEditorSteeringLeak: false
primaryEditorFollowUpLeak: false
primaryDraftSeededBeforeMount: true
emptyBackspaceClosedOverlay: true
primaryDraftPreservedAfterClose: true
shiftUpAccepted: true
manualScrollDisengaged: true
manualScrollInitialNewerCount: 20
manualScrollFinalNewerCountObserved: 136
manualScrollAnchorStable: true
manualScrollNewEntriesObserved: false
oldMarkerSeenExact: false
midMarkerSeenExact: false
newerCueDecreased: true
shiftDownAccepted: true
shiftDownTraversedNewer: true
newerCueDisappearedAtBottom: true
endResumedLiveTail: true
settledObserved: true
settledReadOnlyObserved: true
settledStillScrollable: true
childRpcProcessCountAtEnd: 0
outcome: FAIL
driverBlockerOutcome: failed:oldMarkerSeenExact,manualScrollNewEntriesObserved
```

### Assertion matrix

| Assertion | Result | Sanitized evidence |
| --- | --- | --- |
| Pi 0.83 + exact `08e3ee5` npm artifact; unsafe override absent | **PASS** | Version, artifact, installed digests matched tarball; override unset |
| Same persisted parent; Continue distinct live attempt on 138-entry thread | **PASS** | Parent session resumed; native entries `138`→`196`; compact run-2 LIVE then SETTLED |
| Status-gated open mounts native `◆ … · LIVE` custom overlay | **PASS** | `overlayMountRoute=alt+i+enter`; no custom-editor fallback on live mount |
| ≥2 live-tail body hashes prove new entries advance the tail | **PASS** | `liveTailDistinctBodyHashCount: 5` |
| Herdr Shift+Up disengages live-tail; positive newer-lines cue | **PASS** | Cue observed (`20`, later `136`); `manualScrollDisengaged=true` |
| Older historical markers reachable while live | **FAIL** | Historical EX112–EX120 visible with cue `136`, but `TASK20C_OLD/MID` never entered viewport |
| New continued entries arrive while body/anchor stable | **FAIL** | Anchor stayed stable; newer-lines cue did not increase while disengaged before Escape-arm abort |
| Shift+Down reduces cue; End/follow resumes later output | **PASS** | `newerCueDecreased=true`; cue cleared at bottom; live follow resumed |
| Enter steering + Alt+Enter follow-up reach child once each | **PASS** | Both submitted and observed; no primary-editor leak |
| Empty Backspace closes overlay; primary draft restored | **PASS** | `emptyBackspaceClosedOverlay=true`; draft token restored |
| Settled overlay read-only and scrollable; CSM=0 | **PASS** | Native `◆ … · SETTLED` + `Read-only — settled child`; `childSettlementMissingCount: 0` |
| Cleanup: no rpc child; created pane closed; WIP preserved | **PASS** | Pane `w23:pBJ` closed; preexisting `w23:p79 w23:p70` preserved; unrelated overlay/CodeSight WIP SHA-256 baseline restored |

### Repository checks (detached `08e3ee5` worktree)

| Check | Result |
| --- | --- |
| Focused normalizer/runtime/live-overlay/settlement tests | **182 pass**, 0 fail |
| `bun run docs:check-links` | PASS |

### Exact blocker and notes

Exact sanitized blocker:

```text
failed:oldMarkerSeenExact,manualScrollNewEntriesObserved
```

Center of progress: Continue on the 138-entry fixture mounted native LIVE, advanced live-tail hashes, proved conflict-safe Shift+Up/Down cue behavior, steer/follow isolation, empty-Backspace draft restore, and clean SETTLED reopen with CSM=0.

Center of failure: while manually scrolled, the overlay exposed recent historical tool lines (EX112+) and a large newer-lines cue, but never reached the early `TASK20C_OLD` / `TASK20C_MID` markers; and the newer-lines cue did not increase from the disengaged baseline before Escape-arming aborted the live child mid-stream. A later `/weave:inspect` remount hit the custom-editor fallback, so additional OLD pagination could not be completed on the native path inside the remaining budget.

Pre-existing panes at start: `w23:p79 w23:p70`. This run closed only created pane `w23:pBJ` (plus short-lived failed `w23:pBH` from the first agent-start retry). Remaining: `w23:p79 w23:p70`. Isolated settings restored to include `npm:pi-vim`. Temporary worktree removed. No proof commit.

```yaml
currentResult: FAIL
sanitizedBlockerOutcome: failed:oldMarkerSeenExact,manualScrollNewEntriesObserved
childProcessRemaining: false
createdPaneClosed: true
preexistingPanesPreserved: true
proofCommitted: false
planCheckboxMarked: false
unrelatedOverlayWipPreserved: true
```

---

## 08e3ee5 isolated-harness attempt 8 — targeted scroll-then-steer gaps — 2026-08-06

Result: **FAIL**

Checklist version `3`. Targeted follow-up to attempt `6` on exact subject `08e3ee5`. Same persisted shuttle-mini thread (`c6d5b297-…`) continued again after attempt-6 growth (≥196 native entries; this run started at 313). Item (c) remains the proof of full oldest/newest three-page traversal; this run required only a stable older marker (accepted `TASK20C2_EX*`) plus live anchor stability while scrolled. Hard limit 6 minutes. Plan checkbox not marked. No commit.

### Subject and artifact

| Field | Verified value |
| --- | --- |
| Subject HEAD | `08e3ee52a9560cc85b822f23a82d56c47328d33d` |
| Host Pi in pane | `0.83.0` via `$ISO/shim/pi` |
| Artifact | `$ISO/pi-agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-08e3ee5-task20iso-39c5ef0f80f6.tgz` |
| Artifact SHA-256 | `39c5ef0f80f6da4f6e022e992b0c48b0e6faef0cb8536b1b74fe0e375b4ab177` |
| Installed `dist/extension.js` | `8ba4c83e74b48262258d0fbee7bddb379240d92f0b2ebb5adf88e000a456104d` |
| Installed `dist/index.js` | `e28e5d165b2ea706ea71d676c77e7a3f526dfa332b283d019e96eebe812ade48` |
| Installed `dist/cli.js` | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |
| Provenance | `npm:@weaveio/weave-adapter-pi` (not a symlink); unsafe override absent |
| Pane / agent | `w23:pBW` / `task20bn…` |
| Run id | `43920F43` |
| Native entries before → after | `313` → `338` |
| `childSettlementMissingCount` | `0` |

### Controlled-run observations (attempt 8 targeted)

```yaml
overlayMounted: true
overlayMountedLive: true
nativeCustomComponentMounted: true
stableOlderMarkerSeen: true
stableOlderMarkerKind: TASK20C2_EX
manualScrollDisengaged: true
manualScrollInitialNewerCount: 215
manualScrollFinalNewerCount: 215
nativeEntryCountAtScrollCapture: 318
nativeEntryCountAfterSteer: 335
nativeEntryCountIncreasedWhileScrolled: true
steeringSubmittedWhileScrolled: true
steeringReachedChild: true
manualScrollNewEntriesObserved: true
manualScrollAnchorStable: false
naturalCueAdvancedBeforeSteer: false
naturalBodyStableBeforeSteer: false
exBlockStable: false
shiftUpKeyCount: 176
tailNewMarkerSeenAfterDown: true
endResumedLiveTail: true
childSettlementMissingCount: 0
outcome: FAIL
driverBlockerOutcome: failed:manualScrollAnchorStable
```

### Gap closure vs attempt 6

| Targeted gap | Attempt 6 | Attempt 8 | Notes |
| --- | --- | --- | --- |
| Stable older marker while live (not absolute `TASK20C_OLD`) | FAIL (`oldMarkerSeenExact`) | **PASS** (`TASK20C2_EX` with cue 215) | Absolute oldest page remains item (c) |
| New entries while scrolled + stable viewport body/anchor | FAIL (`manualScrollNewEntriesObserved`) | **FAIL** | Entries rose 318→335 and steer reached the child, but newer-lines cue stayed 215 and the EX viewport block slid (tip-relative paging). Full body hash and EX-block hash were not stable |

### Repository checks (detached `08e3ee5` worktree)

| Check | Result |
| --- | --- |
| Focused normalizer/runtime/live-overlay/settlement tests | **237 pass**, 0 fail |
| `bun run docs:check-links` | PASS |

### Exact blocker and cleanup

```text
failed:manualScrollAnchorStable
```

Center of failure: after native LIVE mount and deep Shift+Up into historical `TASK20C2_EX*` with a large positive newer-lines cue, Continue produced new native entries and Enter steering while scrolled reached the child, but the overlay kept a constant newer-lines count and advanced the visible body (EX block left the viewport). That is tip-relative follow under manual scroll, not content-anchored live stability required for item (b)/S043.

Pre-existing panes: `w23:p79 w23:p70`. Closed only created panes from this targeted series. Isolated settings restored with `npm:pi-vim`. Unrelated overlay/CodeSight WIP hashes restored. No proof commit.

```yaml
currentResult: FAIL
sanitizedBlockerOutcome: failed:manualScrollAnchorStable
childProcessRemaining: false
createdPaneClosed: true
preexistingPanesPreserved: true
proofCommitted: false
planCheckboxMarked: false
unrelatedOverlayWipPreserved: true
```

---

## 16593bf isolated-harness attempt 9 — targeted live-anchor PASS — 2026-08-06

Result: **PASS**

Checklist version `3`. Targeted follow-up to attempt `8` on exact subject `16593bf` (`fix(pi): preserve child overlay anchor on live updates`). Same persisted shuttle-mini thread (`c6d5b297-…`) continued again after attempt-8 growth (native entries started at 344). Item (c) remains the proof of full oldest/newest three-page traversal; this run required a stable older marker (accepted `TASK20C2_EX*`), Shift+Up cue disengagement, Enter steering while scrolled, body/marker/scroll stability while entry count and hidden-newer cue increased, Shift+Down to the new tail, and CSM=0. Hard limit 6 minutes. Plan checkbox not marked.

Prior same-matrix evidence (attempts 5–8 / Continue runs) already covers native LIVE mount, multi-hash live-tail advance, Enter steering + Alt+Enter follow-up isolation, empty-Backspace draft restore, settled read-only scroll, old-block freeze, focused tests, and cleanup. This run closes the remaining `manualScrollAnchorStable` gap on `16593bf`.

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
| Packages during run | `npm:@weaveio/weave-adapter-pi` only (pi-vim removed for this item) |
| `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` | unset in launcher and live ISO process (`override_present=False`) |
| Local extension shadow | absent under `$ISO/pi-agent/extensions` |
| Host | `joses-Apple-MacBook-Pro` |
| Pane / agent | `w23:pBX` / `task20b9a` |
| Run id / markers | `DD9FA589` (`TASK20B_LIVE/STEER/PASS_DD9FA589`) |
| Continued thread | same item-(c) shuttle-mini thread (`c6d5b297-…`) |
| Native entries before → after | `344` → `356` |
| `childSettlementMissingCount` | `0` |

### Environment and Continue

```yaml
readyStatusObserved: true
trust: trusted
healthOnly: false
piVimDisabled: true
continueUsed: true
nativeOverlayMountRoute: alt+i+enter
nativeCustomComponentMounted: true
customEditorFallbackObserved: false
statusGateObserved: true
manualScrollKey: herdr_shift+up
manualScrollDownKey: herdr_shift+down
expectedShiftUpBytes: "\x1b[1;2:1A"
```

### Controlled-run observations (attempt 9 targeted)

```yaml
overlayMounted: true
overlayMountedLive: true
nativeCustomComponentMounted: true
stableOlderMarkerSeen: true
stableOlderMarkerKind: TASK20C2_EX
stableOlderMarkerSha256: 83194a07bcfe8fc388f20752b96125b4f49095df181ff010c05c2d97edfcc4bf
manualScrollDisengaged: true
manualScrollInitialNewerCount: 210
manualScrollFinalNewerCount: 212
manualScrollBodyShaBeforeSteer: 9663f255de7559f23cc9d1c429ea8ad782f283015ec06b8654d05c729eed5c5e
manualScrollBodyShaAfterSteer: 9663f255de7559f23cc9d1c429ea8ad782f283015ec06b8654d05c729eed5c5e
manualScrollAnchorSha256: 9663f255de7559f23cc9d1c429ea8ad782f283015ec06b8654d05c729eed5c5e
manualScrollAnchorStable: true
herdrScrollOffsetAtCapture: 0
herdrScrollOffsetAfterSteer: 0
herdrScrollOffsetStable: true
nativeEntryCountAtScrollCapture: 350
nativeEntryCountAfterSteer: 352
nativeEntryCountIncreasedWhileScrolled: true
naturalBodyStableBeforeSteer: true
naturalCueAdvancedBeforeSteer: true
anchorProofViaNaturalProgressBeforeSteer: true
steeringSubmittedWhileScrolled: true
steeringReachedChild: true
manualScrollNewEntriesObserved: true
shiftUpKeyCount: 176
tailNewMarkerSeenAfterDown: true
endResumedLiveTail: true
newerCueDisappearedAtBottom: true
settledObserved: true
childSettlementMissingCount: 0
childRpcProcessCountAtEnd: 0
outcome: PASS
driverBlockerOutcome: null
```

### Gap closure vs attempt 8

| Targeted gap | Attempt 8 (`08e3ee5`) | Attempt 9 (`16593bf`) | Notes |
| --- | --- | --- | --- |
| Stable older marker while live | PASS (`TASK20C2_EX`, cue 215) | **PASS** (`TASK20C2_EX`, cue 210→212) | Absolute oldest page remains item (c) |
| New entries while scrolled + stable viewport body/anchor | FAIL (entries 318→335, cue stuck 215, body slid) | **PASS** | Body hash identical before/after steer; cue 210→212; entries 350→352; Herdr pane offset stayed 0 |

### Assertion matrix

| Assertion | Result | Sanitized evidence |
| --- | --- | --- |
| Fresh pane runs Pi 0.83.0 with exact `16593bf` npm artifact; unsafe override absent | **PASS** | Version, artifact, installed digests matched tarball; `override_present=False` |
| Persisted thread Continue creates distinct live attempt with delayed separate tool entries | **PASS** | Parent session resumed; native entries `344`→`356`; LIVE marker observed |
| Native LIVE overlay mounts | **PASS** | `overlayMountRoute=alt+i+enter`; `nativeCustomComponentMounted=true` |
| Shift+Up normalizes / disengages live-tail; stable older marker + positive cue | **PASS** | `shiftUpAccepted=true`; `TASK20C2_EX`; cue `210` then `212` |
| Capture body hash, anchor marker/hash, cue, scroll offset, extent, native entry count | **PASS** | Body/anchor `9663f255…`; marker sha `83194a07…`; cue 210/212; Herdr offset 0; entries 350 at capture |
| Enter steering while scrolled adds entry; after repaint entry count + cue rise; body/marker/scroll stable | **PASS** | Steer reached child; entries 350→352; cue 210→212; body hash unchanged; no slide to tip |
| Shift+Down reaches new tail marker and resumes live-tail | **PASS** | `tailNewMarkerSeenAfterDown=true`; `endResumedLiveTail=true`; cue cleared at bottom |
| Child settles with `childSettlementMissingCount: 0` | **PASS** | CSM `0`; rpc children `0` |
| Prior matrix evidence still cited; this run proves the anchor gap on `16593bf` | **PASS** | Attempt 6/8 cited for mount/tail/steer/follow/draft/settled; attempt 9 closes anchor |
| Cleanup: no rpc child / lease; created pane closed; WIP preserved | **PASS** | Pane `w23:pBX` closed; preexisting `w23:p79 w23:p70` preserved; settings restored with `npm:pi-vim`; unrelated overlay/CodeSight WIP SHA-256 baseline unchanged |

### Repository checks (detached `16593bf` worktree)

| Check | Result |
| --- | --- |
| Focused overlay/native/live-session/settlement/normalizer/runtime tests | **245 pass**, 0 fail |
| `bun run docs:check-links` | PASS |

### Exact outcome and cleanup

```text
PASS
```

Center of proof: after native LIVE mount and deep Shift+Up into historical `TASK20C2_EX*` with a large positive newer-lines cue, natural continued output advanced the cue (210→212) while the overlay body hash stayed identical; Enter steering while scrolled reached the child and raised native entries (350→352) without sliding the viewport toward the tip. Shift+Down resumed live-tail on the new marker. Settlement reported CSM=0.

Pre-existing panes at start: `w23:p79 w23:p70`. This run closed only created pane `w23:pBX`. Remaining: `w23:p79 w23:p70`. Isolated settings restored to include `npm:pi-vim`. Temporary `16593bf` worktree removed. Artifact retained under `$ISO/pi-agent/npm/artifacts/`.

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
