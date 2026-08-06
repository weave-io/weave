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

## Title-bound-fix rerun — `d2daabb` (2026-08-06)

Result: **FAIL**

This fresh rerun preserved the earlier failures above. It recorded only bounded,
sanitized evidence.

```yaml
sourceCommitSha256: d2daabb9242dc9d805d5ad4be586c13157875875
installedExtensionSha256: 430c06be3433325fbf13c8f12fa5f55e647b1fb1c26ecb2631baeb01691ba017
installedExtensionHashMatched: true
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
paneCreateSplitCloseCount: 0
nestedPiLaunchCount: 0
productionCodeChanged: false
```

The persisted fixture matched the handoff. The marker was derived in memory from
the persisted data only and was not recorded.

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
markerDerivedLocally: true
```

The registered inspector opened its picker and selected the completed child with
the maximum-length persisted title. The native historical overlay did not mount.
The health command reported the bounded fallback subcode below, so the run stopped
at that fail-closed boundary.

```yaml
registeredInspectCommandUsed: true
nativePickerOpened: true
completedMaximumLengthTitleVisible: true
completedMaximumLengthTitleSelected: true
pickerOpenWaitMilliseconds: 2000
selectionMountWaitMilliseconds: 3000
selectionAttemptCount: 1
nativeHistoricalOverlayMounted: false
customEditorFallbackActivated: true
healthCommandUsed: true
fallbackReasonCode: open-describe-failed
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
primarySubmissionDeltaDuringInspection: 0
primaryDraftByteCountBefore: 0
primaryDraftByteCountAfter: 0
primaryDraftRestored: true
piVimInsertRestored: true
readyAfterClose: true
```

### Title-bound-fix rerun verdict

**FAIL** — picker selection reached the bounded `open-describe-failed` fallback.
The native historical overlay did not mount, so read-only behavior, both bounded
pages, gap-free pagination, viewport and selection preservation, all-page native
search, and ten-match navigation were not directly observed.

```yaml
currentResult: FAIL
sanitizedBlockerOutcome: open-describe-failed
cleanupTargetCount: 2
codesightChurnRestored: true
task20cTemporaryFileCountAfterCleanup: 0
currentPaneLeftOpen: true
```

## Remediation note — resume-origin repair (offline, 2026-08-06)

This proof stays **FAIL** until item (c) is rerun in a fresh Herdr Pi session.

Offline diagnosis against Pi 0.83 and the exact resume fixture shape: after a
restart that reopens the same parent session file, `SessionManager.getSessionId()`
can be a freshly minted runtime id while the file's persisted header `id` stays
stable. Using the runtime id as child-ref origin authority origin-mismatched every
historical ref this session itself wrote, so picker selection could not describe
the settled child for the native overlay and fell through to
`open-describe-failed`.

Remediation:

- Parent persistence probing prefers the bounded non-empty header `id` from the
  host's public `SessionManager.getHeader()` when present. That single persisted
  identity is the origin authority for child refs. The runtime id is retained for
  diagnostics only.
- Fork, clone, and genuinely new sessions mint a new header id, so imported source
  refs stay origin-mismatched and excluded. Absent, invalid, or oversized headers
  fall back to the live runtime id for that process only; a throwing header probe
  fails closed as `unknown` / `probe-failed` and never fabricates an origin.
- Production `session_start` already passes the live `ctx.sessionManager` into
  `PiPrimarySession`; an extension-boundary test asserts `getHeader()` is read and
  that the header id — not the divergent runtime id — is handed to thread sources.

```yaml
remediationDiagnosedOffline: true
remediationCause: parent_origin_used_ephemeral_runtime_id_instead_of_persisted_header_id
remediationRegressionFailedBeforeFix: true
remediationRegressionPassesAfterFix: true
remediationForkCloneExclusionRetained: true
remediationArbitraryPriorOriginRejected: true
remediationFailOpenIntroduced: false
```

This note records the offline diagnosis and repair only. The result above stays
**FAIL** until a fresh Herdr run re-observes the native historical overlay,
pagination, and bounded search end to end.

## Resume-origin-fix rerun — `bee7844` (2026-08-06)

Result: **FAIL**

This fresh process-restart rerun preserved every earlier result above. It recorded
only bounded, sanitized evidence.

```yaml
sourceCommitSha256: bee7844979ee0b06ccfa1feef0e725052c243c2c
installedExtensionSha256: d1afe6497936ea08fbd6352d7db588f8d2a2b125a4aec0cf20b83fa73ed6c653
installedExtensionHashMatched: true
piVersion083: true
requestedCurrentPaneMatched: true
readyFooterObserved: true
statusTrusted: true
healthOnly: false
weaveNpmPackageConfiguredCount: 1
piVimNpmPackageConfiguredCount: 1
unsafeOverrideCount: 0
localWeaveShadowCount: 0
paneCreateSplitCloseCount: 0
nestedPiLaunchCount: 0
productionCodeChanged: false
```

The persisted fixture matched the handoff. The marker was derived in memory only
and was never persisted.

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
markerDerivedLocally: true
markerPersisted: false
```

The picker exposed the persisted completed child after the parent process restart,
and selection reached native-overlay open. Native mounting then failed closed. The
health command reported only the bounded reason code below.

```yaml
registeredInspectCommandUsed: true
nativePickerOpened: true
stableSessionHeaderOriginResolvedPersistedChild: true
completedMaximumLengthTitleVisible: true
completedMaximumLengthTitleSelected: true
pickerOpenMilliseconds: 10
selectionAttemptCount: 1
nativeHistoricalOverlayMounted: false
customEditorFallbackActivated: true
healthCommandUsed: true
fallbackReasonCode: open-describe-failed
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
primaryInputIsolationObserved: false
primarySubmissionDeltaDuringInspection: 1
primaryDraftRestored: false
piVimInsertRestored: true
readyAfterFallback: true
```

### Resume-origin-fix rerun verdict

**FAIL** — picker selection reached the bounded `open-describe-failed` fallback.
The native historical overlay did not mount, so none of the required native
read-only, pagination, viewport, selection, search, or isolation criteria reached
a complete direct proof.

```yaml
currentResult: FAIL
sanitizedBlockerOutcome: open-describe-failed
cleanupTargetCount: 2
codesightChurnRestored: true
task20cTemporaryFileCountAfterCleanup: 0
currentPaneLeftOpen: true
```

## Remediation note — post-resume describe replay (offline, 2026-08-06)

This proof stays **FAIL** until item (c) is rerun in a fresh Herdr Pi session.

The recorded `open-describe-failed` was replayed offline against the exact
persisted fixture this rerun used, through the real production boundary: the
persisted parent session reopened by the host `SessionManager`, the real thread
sources, the real picker row builder, and the real delegation controller. **The
failure did not reproduce.** No repair of the resolution path is therefore
claimed, and none was made.

Only hashes, counts, and discriminants were captured. No raw id, path, title,
marker, prompt, or transcript text was read into a file or into this note.

```yaml
replayUsedExactFixture: true
replayUsedRealSessionManager: true
replayUsedRealThreadSources: true
replayUsedRealPickerRowBuilder: true
replayUsedRealDelegationController: true
persistedHeaderIdEqualsRuntimeId: true
persistedHeaderPresent: true
persistedHeaderVersion: 3
stableSessionHeaderFixActiveInReplay: true
refOriginDistinctCount: 1
refOriginEqualsPersistedHeaderId: true
parentEntriesScanned: 101
refCandidateEntryCount: 2
refMalformedEntryCount: 0
refOriginMismatchedChildCount: 0
refConflictingChildCount: 0
refDuplicateEntryCount: 0
refUnusableSourceChildCount: 0
refUsableRefCount: 1
refIssueCount: 0
readRefsDefaultLimitRefCount: 1
readRefsControllerLimitRefCount: 1
pickerRowIdEqualsDurableChildId: true
pickerRowIdEqualsDurableThreadId: true
resolveOverlayChildOutcome: ok
resolveOverlayChildErrorDiscriminatorCount: 0
resolvedStatus: settled
resolvedTitleLength: 200
resolvedSessionRefPresent: true
resolvedRunCount: 1
describeFailedReproducedOffline: false
speculativeResolutionFixIntroduced: false
```

Ruled out by the replay, each against the exact fixture:

- Picker row identity. The row id the picker hands to `activateChild` is the
  durable `childId` itself, and the picker entry carries its node, so the id the
  controller receives is the persisted one.
- Ref scanning and its bounds. The picker's default `readRefs()` limit and the
  controller's own limit both clamp to the same returned-ref bound, and both
  returned the same single usable ref with zero issues.
- Ref origin. The persisted origin equals the persisted session-header id, and
  the host reported an identical runtime id for this fixture, so the retained
  session-header origin fix is active and no divergence existed here to close.
- Native source authority. The child session opened against its recorded
  expected parent, with no tombstone and no root, header, or parent-equality
  violation.
- Controller lifecycle. The delegation controller and the overlay controller are
  published and revoked together in one generation block, so an absent
  delegation controller reports `controller-absent`, never `open-describe-failed`.

What the replay did expose is a diagnostics gap, and only that was repaired:

- `open-describe-failed` covered four distinct source failures at once —
  unknown child, unavailable source, corrupt source, and not-yet-ready source.
  Each now reports its own bounded, identifier-free subcode, so the next run
  names which failure it hit. A describe failure with no known discriminant
  still reports the original generic code.
- Production `describe` collapsed every delegation-controller failure into
  `ChildNotFound`. It now maps an unreadable ref source to an unavailable
  source and a thread integrity failure to a corrupt source, while an unknown or
  origin-mismatched thread stays a missing child. Every branch stays inside the
  fallback-classified errors, so the fallback decision itself is unchanged.
- The fallback metadata carries the source-error discriminant only — never the
  failing operation, a thread id, a path, or any free-form failure text.

Fork and clone origin exclusion, new-session isolation, the 200-character title
bound, the mandatory non-empty expected parent, and root, authority, header, and
corruption fail-closed behavior are all unchanged and still covered.

```yaml
remediationDiagnosedOffline: true
remediationScope: diagnostics_only
remediationCause: open_describe_failed_covered_four_distinct_source_failures
remediationRegressionFailedBeforeFix: true
remediationRegressionPassesAfterFix: true
remediationFallbackDecisionChanged: false
remediationChildNotFoundCollapseRemoved: true
remediationForkCloneExclusionRetained: true
remediationExpectedParentValidationRetained: true
remediationTitleBoundRetained: true
remediationFailOpenIntroduced: false
```

The next rerun must record the exact fallback subcode from `/weave:health`. The
result above stays **FAIL** until a fresh Herdr run re-observes the native
historical overlay, both bounded pages, gap-free pagination, viewport and
selection preservation, and bounded native search end to end.

## Typed-diagnostics rerun — `dc37fcb` (2026-08-06)

Result: **FAIL**

This fresh rerun preserved all earlier attempts and recorded only bounded,
sanitized evidence.

```yaml
sourceCommitSha256: dc37fcb0f5b8d9b7b6cad81aa0e432dd715404ea
installedExtensionSha256: 5d68b19a4e89bdcc6622921b966802e451f167df1745525f18a99c5321f61719
installedExtensionHashMatched: true
piVersion083: true
requestedCurrentPaneMatched: true
readyFooterObserved: true
statusTrusted: true
healthOnly: false
weaveNpmPackageConfiguredCount: 1
piVimNpmPackageConfiguredCount: 1
unsafeOverrideCount: 0
localWeaveShadowCount: 0
paneCreateSplitCloseCount: 0
nestedPiLaunchCount: 0
productionCodeChanged: false
```

The persisted fixture hash and entry count matched the existing contract. Native
mounting failed before search, so no marker value was derived or entered.

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
transcriptHashMatchedExistingFixture: true
markerDerived: false
markerPersisted: false
```

The completed historical child was selected once. The native overlay did not
mount. The fallback was closed before the health command recorded its single
bounded describe-source subcode.

```yaml
registeredInspectCommandUsed: true
nativePickerOpened: true
completedHistoricalChildSelected: true
pickerOpenMilliseconds: 0
historicalSelectionCount: 1
nativeHistoricalOverlayMounted: false
customEditorFallbackActivated: true
customEditorFallbackClosed: true
healthCommandUsed: true
fallbackReasonCode: open-describe-child-not-found
fallbackReasonCodeCount: 1
nativeReadOnlyStatusObserved: false
nativeEntryCountObserved: false
nativeNewestPageCountObserved: false
nativeOlderPageCountObserved: false
nativePaginationObserved: false
nativePaginationGapCountObserved: false
nativePaginationDuplicateCountObserved: false
nativeViewportAnchorPreservedObserved: false
nativeSearchInputObserved: false
nativeBoundedPageScanObserved: false
nativeMatchNavigationObserved: false
nativeInputIsolationObserved: false
nativeInterventionIsolationObserved: false
searchQueryEntered: false
primarySubmissionAddedByNativeOverlayCount: 0
piVimInsertRestored: true
readyAfterFallbackClose: true
```

### Typed-diagnostics rerun verdict

**FAIL** — `open-describe-child-not-found`

```yaml
currentResult: FAIL
sanitizedBlockerOutcome: open-describe-child-not-found
cleanupTargetCount: 2
codesightChurnRestored: true
task20cTemporaryFileCountAfterCleanup: 0
currentPaneLeftOpen: true
```

## Remediation note — live session manager for child refs (offline, 2026-08-06)

This proof stays **FAIL** until item (c) is rerun in a fresh Herdr Pi session.

The recorded `open-describe-child-not-found` was reproduced offline at the
extension boundary against a real settled child, a real native session on disk,
and the durable parent ref ledger. Pi replaces `ctx.sessionManager` across a
session load, while the parent ref reader was built once at `session_start` and
captured that startup context. After the replacement the captured manager
reports no entries for the parent, so the ref ledger read empty and the picked
child could not be described, even though the session file and every durable ref
were unchanged.

Remediation:

- The extension holds the newest session context Pi handed it, scoped to the
  generation that observed it. The long-lived ref-store read port resolves that
  context at call time instead of holding the startup one.
- The scope is a single generation. A retained closure from a replaced
  generation reads `undefined` and falls back to its own captured startup
  context; it can never reach a newer generation's session manager, so no
  session or fork authority is crossed. Generation disposal clears the cell only
  while that generation still owns it, so a late-disposing predecessor cannot
  strip the live generation's context.
- Command and `before_agent_start` boundaries record the context they were
  handed, which is how a freshly built command context reaches the reader with
  no lifecycle callback in between.
- The read itself is fail-closed. An absent context, an absent manager, a
  manager without `getEntries`, and a throwing `getEntries` all yield no entries
  plus one bounded, identifier-free degradation code, logged once per shape per
  generation. An empty ledger is already treated everywhere as "no durable
  children", never as authority to skip a check.
- `PiGenerationResourceOwner` disposal keeps its `never` failure type: the new
  cleanup hook is invoked through `Result.fromThrowable`, so a throwing hook
  cannot escape disposal.

The generation-scoped helpers and the resource owner live in an internal module
that the package `exports` map does not expose and that the package entry point
does not re-export. The generated `./extension` and `.` declarations therefore
carry none of them, and no public API documentation changed. Tests reach the
module through a relative import; the public surface was not widened for them.

Disposal safety is pinned directly rather than inferred: a resource owner built
with a throwing cleanup hook still resolves `dispose()` as a successful
`ResultAsync<void, never>`, still shuts down the telemetry and runtime store it
adopted, runs the hook exactly once, and stays safe under repeated disposal.

The boundary coverage runs entirely on in-memory seams. It spawns no process,
runs no shell command, creates no temporary directory, and writes no real file:
the native session, its 69 persisted historical entries, the parent ref ledger,
the metadata cache, the telemetry log filesystem
(`MemoryRuntimeLogFileSystem`), and the recovery pointer store
(`InMemoryRecoveryPointerStore`) all use repository-provided in-memory
fixtures.

```yaml
remediationDiagnosedOffline: true
remediationCause: child_ref_reader_captured_startup_session_manager_after_pi_replaced_it
remediationRegressionFailedBeforeFix: true
remediationRegressionPassesAfterFix: true
remediationGenerationScoped: true
remediationCrossGenerationLeakPossible: false
remediationFallbackCrossesSessionAuthority: false
remediationDisposalNeverthrowSafe: true
remediationDisposalThrowingHookTestedDirectly: true
remediationFailOpenIntroduced: false
remediationPublicApiChanged: false
remediationInternalModuleExportedFromPackage: false
remediationTestProcessSpawnCount: 0
remediationTestShellCommandCount: 0
remediationTestTempDirectoryCount: 0
remediationTestRealFileWriteCount: 0
remediationTelemetryLogFileSystem: MemoryRuntimeLogFileSystem
remediationRecoveryPointerStore: InMemoryRecoveryPointerStore
remediationHistoricalFixtureEntryCount: 69
```

This note records the offline diagnosis and repair only. The result above stays
**FAIL** until a fresh Herdr run re-observes the native historical overlay, both
bounded pages, gap-free pagination, viewport and selection preservation, and
bounded native search end to end.

## Live-session-manager-fix rerun — `87253f3` (2026-08-06)

Result: **FAIL**

This fresh rerun preserved all earlier attempts and recorded only bounded,
sanitized evidence.

```yaml
sourceCommitSha256: 87253f3895e9331421cc65d01582f630db163980
installedExtensionSha256: 70522a5122880af567b522207dead47e1d3908a5a6a4abe11954506b961a3ab3
installedExtensionHashMatched: true
piVersion083: true
requestedCurrentPaneMatched: true
readyFooterObserved: true
statusTrusted: true
healthOnly: false
weaveNpmPackageConfiguredCount: 1
piVimNpmPackageConfiguredCount: 1
unsafeOverrideCount: 0
localWeaveShadowCount: 0
paneCreateSplitCloseCount: 0
nestedPiLaunchCount: 0
productionCodeChanged: false
```

The persisted fixture hash and entry count matched the existing contract. Native
mounting failed before search, so no marker value was derived or entered.

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
transcriptHashMatchedExistingFixture: true
markerDerived: false
markerPersisted: false
```

The completed historical child was selected once. The native overlay did not
mount. The fallback was closed before the health command recorded its single
bounded subcode.

```yaml
registeredInspectCommandUsed: true
nativePickerOpened: true
completedHistoricalChildSelected: true
pickerOpenMilliseconds: 0
historicalSelectionCount: 1
nativeHistoricalOverlayMounted: false
customEditorFallbackActivated: true
customEditorFallbackClosed: true
healthCommandUsed: true
fallbackReasonCode: open-describe-child-not-found
fallbackReasonCodeCount: 1
nativeReadOnlyStatusObserved: false
nativeEntryCountObserved: false
nativeNewestPageCountObserved: false
nativeOlderPageCountObserved: false
nativePaginationObserved: false
nativePaginationGapCountObserved: false
nativePaginationDuplicateCountObserved: false
nativeViewportAnchorPreservedObserved: false
nativeSearchInputObserved: false
nativeBoundedPageScanObserved: false
nativeMatchNavigationObserved: false
nativeQueryIsolationObserved: false
nativeEnterIsolationObserved: false
nativeAltEnterIsolationObserved: false
searchQueryEntered: false
primarySubmissionAddedByNativeOverlayCount: 0
primaryDraftRestored: true
piVimInsertRestored: true
readyAfterFallbackClose: true
```

### Live-session-manager-fix rerun verdict

**FAIL** — `open-describe-child-not-found`

```yaml
currentResult: FAIL
sanitizedBlockerOutcome: open-describe-child-not-found
cleanupTargetCount: 2
codesightChurnRestored: true
task20cTemporaryFileCountAfterCleanup: 0
currentPaneLeftOpen: true
```
