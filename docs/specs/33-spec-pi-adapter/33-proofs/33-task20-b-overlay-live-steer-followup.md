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
