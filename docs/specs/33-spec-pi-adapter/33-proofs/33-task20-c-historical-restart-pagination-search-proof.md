# Task 20(c) — Historical restart, pagination, and search

Date: 2026-08-06

Result: **FAIL**

This proof covers only Task 20 matrix item (c). It contains no prompt text, transcript text, file path, parent session ID, child ID, or native session ID.

## Restart and provenance

The parent Pi session was restarted in the requested existing pane. No pane was created, split, or closed, and no nested Pi process was launched.

```yaml
requestedCurrentPaneMatched: true
piVersion083: true
parentSessionPathMatchedHandoff: true
parentSessionIdentityMatchedHandoff: true
parentSessionPersisted: true
parentSessionHeaderVersion: 3
readyFooterObserved: true
statusTrusted: true
healthOnly: false
weaveNpmPackageConfigured: true
piVimNpmPackageConfigured: true
localWeavePackageConfigured: false
unsafeOverridePresent: false
piVimInsertObservedBeforeInspection: true
installedExtensionSha256: ac1d12c298300741140d1cefa0e6946489e2fa8a5aeded2873f4c1ea07313061
installedExtensionHashMatched: true
productionCodeChanged: false
paneCreateSplitCloseCount: 0
nestedPiLaunchCount: 0
```

The live footer showed the ready interactive state. The installed npm package and absence of an unsafe provenance override establish trusted, non-health-only operation.

## Persisted fixture integrity

Phase 1 created exactly one controlled settled child. The restarted parent retained two durable child-reference records, including the completed lifecycle state. Pi's session API reopened the parent successfully before inspection.

```yaml
controlledChildCount: 1
childSettlementOutcome: completed
childInterventionCount: 0
durableParentReferenceCount: 2
persistedTranscriptEntryCount: 69
historicalPageSize: 50
historicalPageCount: 2
oldestPageEntryCount: 19
newestPageEntryCount: 50
controlledUniqueEventCount: 30
controlledEventSequenceComplete: true
persistedMarkerMatchCount: 3
transcriptSha256: aef2be4b99aa40e640437f6ff4d81b37dd2b322b9250a18153e0a385a65a8d01
transcriptHashMatchedHandoff: true
searchQuerySha256: 7cf5b14e3d66c4b97fadcf9a99950620ad4399d05d316898c814b9da68f35c87
searchHashMatchedHandoff: true
```

These checks prove the durable fixture and its expected page boundaries. They do not prove native overlay behavior.

## Registered inspection route

The verifier entered the registered `/weave:inspect` command through the primary editor after restart. The native picker opened and showed the settled historical child. A slow retry separately moved selection from the root row to that history row and submitted it.

```yaml
registeredInspectCommandUsed: true
nativePickerOpened: true
historicalPickerEntryVisible: true
historicalPickerEntrySelected: true
activeRunShortcutUsed: false
selectionRetryCount: 1
```

After selection, the adapter did not mount the native full-screen historical overlay. It activated the custom-editor fallback instead. The fallback visibly reported a completed read-only child and exposed the fallback editor layout. This result reproduced after a slower, separately timed picker selection.

Exact sanitized blocker:

```text
historical_selection_activated_custom_editor_fallback_instead_of_native_overlay
```

## Assertion matrix

| Required assertion | Result | Direct observation |
| --- | --- | --- |
| Restarted Pi is ready, trusted, and non-health-only | **PASS** | Ready footer, npm provenance, interactive command availability, and absent unsafe override were observed. |
| Restarted parent identity matches the handoff | **PASS** | Path and session identity comparisons were both true; no identity value is retained here. |
| pi-vim owns the primary editor before inspection | **PASS** | `INSERT` was visible before the registered command. |
| Installed extension hash matches | **PASS** | The installed extension SHA-256 matched exactly. |
| Registered command opens the native picker | **PASS** | The picker opened and showed the settled history entry. |
| Picker selection mounts the native historical overlay | **FAIL** | Selection activated the custom-editor fallback instead. |
| Native overlay is read-only | **FAIL — not observed** | The fallback was read-only, but the required native overlay did not mount. |
| Native overlay loads the newest bounded page | **FAIL — not observed** | The native overlay did not mount. The durable newest-page count was verified separately. |
| Native overlay paginates to the older page | **FAIL — not observed** | The native overlay did not mount. |
| Native overlay paginates back without duplicates or gaps | **FAIL — not observed** | The native overlay did not mount. The persisted event sequence was complete and unique, but no native page transition occurred. |
| Scroll and selection survive page transitions | **FAIL — not observed** | No native page transition occurred. |
| Native search finds all persisted marker matches | **FAIL — not observed** | The native overlay and its search path were unavailable. The persisted count and search hash matched independently. |
| Overlay input does not submit to the primary session | **PASS** | Parent entry count was unchanged before and after the inspection interaction. |
| Closing inspection restores pi-vim | **PASS** | Closing the fallback restored a blank primary editor in `INSERT` state. |
| Ready state remains after close | **PASS** | The ready Weave footer remained visible after close. |
| No production code or other pane changed | **PASS** | Production change count, pane creation count, split count, and close count were zero. |

## Verdict and cleanup

**FAIL** — Task 20(c) is not complete because the selected historical child did not mount the native overlay. Pagination, scroll preservation, and native search therefore remain unproved.

```yaml
parentSubmissionLeak: false
piVimInsertRestored: true
readyAfterClose: true
runtimeStoreLeaseActive: false
childProcessRemaining: false
otherPanesAlteredCount: 0
panesClosedCount: 0
coordinatorCleanupTargetCount: 1
coordinatorCleanupTarget: current_proof_pane_when_no_longer_needed
```

The current proof pane remains open as required. A remediation must keep historical selection on the native overlay path after restart, then rerun item (c) and directly observe both page transitions, stable viewport state, and native search.

## Remediation note (2026-08-06)

This proof stays **FAIL** until item (c) is rerun in a fresh Herdr Pi session.

An earlier remediation changed `readOverlaySessionEntryPage` to verify a persisted
child session against the parent session recorded in the child's own durable ref
record instead of the live parent session identity. That change was **speculative**
and has been reverted: it was never reproduced fail-first, the restarted parent
identity matched the handoff in this very proof, and the ref reader already excludes
origin-mismatched records, so the divergence it claimed to close did not exist. The
extension-boundary restart test passed on the pre-change baseline as well and is now
labelled as boundary coverage rather than regression coverage.

The following adapter changes are retained, each covered by a focused test proven to
fail before the change:

- Every persisted session ref must have an expected parent session. When none is
  known, `readOverlaySessionEntryPage` fails closed before reading rather than
  passing `undefined` through, which would make the native store skip parent
  equality entirely. Root, auth, header, cursor, and corruption failures stay
  fail-closed and verbatim.
- Overlay search scans every page inside the existing bounded historical page
  budget instead of stopping at the first page that contains a match, and merges
  matches from all scanned pages in stable transcript order without duplicates.
  Matches trimmed out of the bounded window still count, so the reported total and
  `n` / `N` navigation cover the whole scanned range.
- Every native-overlay to custom-editor fallback decision now records a bounded
  reason code, printed by `/weave:health` as `overlay: weave overlay fallback:
  <code>`. The codes are a closed set and carry no identifier, path, prompt, or
  transcript text.
- The focused native overlay keeps its documented in-overlay search route: `ctrl+f`
  opens a search prompt, Enter runs the search, `n` / `N` walk matches, and Escape
  exits search without closing the overlay or leaking a key to the primary editor.
  The key is offered to the same host conflict port every other overlay key uses;
  when the host already binds it, the route is disabled and reported.

The exact production cause of
`historical_selection_activated_custom_editor_fallback_instead_of_native_overlay`
is still **not** reproduced offline, and nothing here may be read as a fix for it.
The rerun must capture the fallback reason code from `/weave:health`; that code
names the decision that the previous run could only observe as a silent path change.

## Approved-artifact rerun — `b586ec4` (2026-08-06)

Result: **FAIL**

This rerun used the approved release artifact. It preserves the earlier failed run
above and records only sanitized outcomes.

```yaml
approvedArtifactSourceCommitHash: b586ec4ce81220088f750ebea2c00a1d9f4e112b
approvedArtifactSha256: 7ee79db93854c6a01ddf3dbfb9798a8560f39b47c5e149cede59aac4b1b094ee
installedExtensionSha256: ee5173d4d0b87e5b2a8467d1e9331ffa5d8f07b2f9bd14868ed375cc7204e944
installedExtensionHashMatched: true
artifactExtensionHashMatched: true
piVersion083: true
requestedCurrentPaneMatched: true
readyFooterObserved: true
statusTrusted: true
healthOnly: false
weaveNpmPackageConfiguredCount: 1
piVimNpmPackageConfiguredCount: 1
unsafeOverrideCount: 0
localWeaveShadowCount: 0
piVimInsertObservedBeforeInspection: true
parentSessionMatchedHandoff: true
parentReopenSucceeded: true
parentReopenedEntryCount: 38
parentHeaderVersion: 3
controlledChildCount: 1
childSettlementOutcome: completed
childInterventionCount: 0
durableParentReferenceCount: 2
completedLifecycleReferenceCount: 1
activeRuntimeLeaseCount: 0
paneCreateSplitCloseCount: 0
nestedPiLaunchCount: 0
productionCodeChanged: false
```

The durable fixture matched the handoff before inspection:

```yaml
persistedTranscriptEntryCount: 68
historicalPageSize: 50
historicalPageCount: 2
olderPageEntryCount: 18
newestPageEntryCount: 50
controlledUniqueEventCount: 30
persistedMarkerMatchCount: 10
olderPageMarkerMatchCount: 6
newestPageMarkerMatchCount: 4
transcriptSha256: 1794e072c31c2720f27ab865cabf31ae499dba47e99ec22e043708dea253fe52
transcriptHashMatchedHandoff: true
markerSha256: e8557f118a904b10c8a56d54e6d4123a3a7fa071f27775dfbbd5ba7c67992fd9
markerHashMatchedHandoff: true
```

The registered inspector opened its native picker. The sole settled history entry
was selected after one downward navigation. Selection activated the custom-editor
fallback instead of the native full-screen historical overlay. The test stopped at
that fail-closed boundary and did not claim any native pagination or search result.

```yaml
registeredInspectCommandUsed: true
nativePickerOpened: true
settledHistoryEntryVisible: true
settledHistoryEntrySelected: true
pickerOpenWaitMilliseconds: 2000
selectionMountWaitMilliseconds: 3000
selectionAttemptCount: 1
nativeHistoricalOverlayMounted: false
customEditorFallbackActivated: true
healthCommandUsed: true
fallbackReasonCode: open-failed
fallbackReasonCodeCount: 1
nativeReadOnlyStatusObserved: false
nativeNewestPageCountObserved: false
nativeOlderPageCountObserved: false
nativePaginationObserved: false
nativePaginationGapCountObserved: false
nativePaginationDuplicateCountObserved: false
nativeViewportAnchorPreservedObserved: false
nativeSelectionPreservedObserved: false
nativeSearchInputObserved: false
nativeBoundedPageScanObserved: false
nativeMatchNavigationObserved: false
searchQueryEntered: false
searchQueryPrimaryEditorLeakCount: 0
searchQueryPrimarySessionLeakCount: 0
inspectExactPrimarySubmissionCount: 0
healthExactPrimarySubmissionCount: 0
primaryDraftByteCountBefore: 0
primaryDraftByteCountAfter: 0
primaryDraftRestored: true
piVimInsertRestored: true
readyAfterClose: true
```

### Approved-artifact rerun verdict

**FAIL** — picker selection reached the bounded `open-failed` fallback. The native
historical overlay did not mount, so read-only behavior, the 50-entry newest page,
the 18-entry older page, gap-free pagination, viewport preservation, bounded search,
and cross-page match navigation were not directly observed.

```yaml
currentResult: FAIL
sanitizedBlockerOutcome: open-failed
coordinatorCleanupTargetCount: 1
coordinatorCleanupTargetOutcome: current_proof_pane_when_no_longer_needed
```

### Remediation note (offline, post-rerun)

The recorded `open-failed` code was reproduced offline against the durable
fixture this rerun used, without re-running Herdr. `ChildOverlayController.open`
rejected the described child before any page was read: the overlay descriptor
schema bounded a child `title` by the run-divider label bound, while the ref
store persists titles up to its own, longer title bound. A real task-derived
title therefore failed descriptor validation with `OverlayInvalidChild`, which
is not a fallback-required error, so the extension reported the generic
`open-failed` code and activated the custom editor.

Remediation:

- The overlay descriptor title bound now equals the ref store's persisted title
  bound, so an already-validated persisted title is admitted unchanged. No other
  validation was relaxed: missing, corrupt, root-violating, unauthorized,
  malformed-header, and parent-mismatch data all stay fail-closed, and
  expected-parent validation remains mandatory and non-empty.
- Every non-fallback `open` error now reports its own bounded, identifier-free
  subcode, so a future run distinguishes an invalid descriptor from a source
  that is not ready, corrupt, unavailable, or unknown instead of collapsing them
  into `open-failed`.
- A boundary regression covers the exact failing shape: a persisted settled
  child whose ref title sits at the ref store's title bound, selected from the
  picker after a parent restart. It fails on the pre-fix schema and passes after.

```yaml
remediationDiagnosedOffline: true
remediationCause: overlay_descriptor_title_bound_shorter_than_persisted_ref_title_bound
remediationOpenErrorType: OverlayInvalidChild
remediationRegressionFailedBeforeFix: true
remediationRegressionPassesAfterFix: true
remediationFailOpenIntroduced: false
remediationExpectedParentValidationRetained: true
```

This note records the offline diagnosis and repair only. The result above stays
**FAIL** until a fresh Herdr run re-observes the native historical overlay,
pagination, and bounded search end to end.
