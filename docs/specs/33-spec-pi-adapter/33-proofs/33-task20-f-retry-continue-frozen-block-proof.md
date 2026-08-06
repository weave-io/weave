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
