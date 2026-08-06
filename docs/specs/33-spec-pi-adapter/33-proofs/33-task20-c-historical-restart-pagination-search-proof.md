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

This proof stays **FAIL** until item (c) is rerun in a fresh Herdr Pi session. The
following adapter changes were made in response to the blocker and are covered by
automated tests only:

- `readOverlaySessionEntryPage` now verifies a persisted child session against the
  parent session recorded in the child's own durable ref record
  (`PiOverlayChildDescriptor.originParentSessionId`) instead of the live parent
  session identity read at page time. A restarted parent generation that reports a
  different live identity no longer turns every historical page read into
  `parent-session-mismatch`. Missing, corrupt, root-violating, and genuinely
  mismatched sessions still fail closed, and the header check is never skipped.
- A new extension-boundary test persists a real child session and a real parent ref
  ledger on disk, restarts the parent generation, selects the historical child
  through the registered `/weave:inspect` picker, and asserts the native overlay
  mounts (`ui.custom` mount with no `setEditorComponent` borrow), renders a bounded
  newest page, and stays read-only.
- The focused native overlay gained a documented in-overlay search route:
  `ctrl+f` opens a search prompt, Enter runs `ChildOverlayController.search`, `n`/`N`
  walk matches, and Escape exits search without closing the overlay or leaking a key
  to the primary editor. The key is offered to the same host conflict port every
  other overlay key uses; when the host already binds it, the route is disabled and
  reported instead of silently stolen.

The exact production cause of `historical_selection_activated_custom_editor_fallback_instead_of_native_overlay`
was **not** reproduced offline: with real persisted sessions and refs, the boundary
test mounts the native overlay both before and after the fix. The origin-parent fix
removes the one code-level divergence found between the picker path (which resolved
the child) and the page path (which did not), but the rerun must confirm it and, if
the fallback recurs, capture the overlay diagnostics printed by `/weave:health`.
