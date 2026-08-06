# Task 20(f) — Retry / continue frozen-block crash-fix

Date: 2026-08-06

Result: **FAIL**

This proof covers only Task 20 matrix item (f). It records a sanitized
crash-fix attempt against Pi 0.83. It does not mark the matrix item complete.

## Attempt

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

## Cleanup

After the abort, the verifier confirmed residual runtime surfaces were clear.

```yaml
residualRpcChildProcessCount: 0
runtimeStoreLeaseActive: false
extraPaneCreateSplitCloseCount: 0
```

## Verdict

**FAIL** — process aborted on over-wide overlay header (`adapterLineWidth=115`
at `terminalWidth=51`) before the frozen-block path could be exercised.

```yaml
currentResult: FAIL
sanitizedBlockerOutcome: overlay_render_width_assertion_abort
pendingFreshRerun: true
```

## Width-fixed rerun

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

### Width regression

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

### Retry and continue blocker

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

### Rerun cleanup

```yaml
residualRpcChildProcessCount: 0
runtimeStoreActiveLeaseCount: 0
productionCodeChangeCount: 0
extraPaneCreateSplitCloseCount: 0
paneLeftOpen: true
```

## Current verdict

**FAIL** — the width regression is fixed, but Task 20(f) remains incomplete
because the corrected active pre-mount shortcut did not open the newly
observed child. The required stop condition prevented retry, continue, and
frozen-block comparison.

```yaml
currentResult: FAIL
widthRegressionFixed: true
sanitizedBlockerOutcome: active_pre_mount_shortcut_failed
pendingFreshRerun: true
```
