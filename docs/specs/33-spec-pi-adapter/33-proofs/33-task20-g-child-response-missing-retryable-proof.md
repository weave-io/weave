# Task 20(g) — ChildResponseMissing retryability

Date: 2026-08-06

Result: **PASS**

Checklist version `3`. Matrix item `(g)` against exact subject `16593bf` in
`$HOME/.local/share/weave/task20-pi083-harness`. Fresh isolated Pi 0.83 pane
delegated one controlled `shuttle-mini` child that finished after a bounded
`pwd` tool call with no terminal assistant response (`ChildResponseMissing`,
reason `tool-only`), surfaced a retryable structured result with opaque
`thread`, freeze-hashed the failed authoritative child-ref line, failed closed
on an arbitrary thread, then retried the exact thread to a distinct completed
run while the failed ref stayed byte-identical. `ChildSettlementMissing` count
was `0`. Plan checkbox not marked.

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
| Pane / agent | `w23:pBZ` / `task20g1` |
| Run id | `G16593` |
| Thread prefix | `7eb76371…` (opaque UUID from structured `weave_delegate` result) |
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
```

### Controlled tool-only ChildResponseMissing

Parent delegated exactly one ordinary no-edit `shuttle-mini` child. The child
ran one bounded bash tool (`pwd`) and finished with no terminal assistant
content. Parent structured result was typed `ChildResponseMissing` (not a
generic timeout / settlement miss).

| Observation | Sanitized value |
| --- | --- |
| Parent error | `ChildResponseMissing` |
| Reason | `tool-only` |
| `retryable` | `true` |
| `recovery` | `retry` |
| Opaque `thread` present | `true` (`7eb76371…`) |
| Prompt/transcript in structured result | `false` |
| Tool use observed | `true` (`pwd`) |
| `ChildSettlementMissing` | `0` |

### Failed source block freeze

CRM start failures return JSON via `startFailureResult` / `threadFailureResult`
(no compact three-line projection on the failure tool result). The frozen
failed source block for this item is the append-only authoritative
`weave.child-ref.v1` lifecycle line with `status: failed`, `run 1 · start`.

| Observation | Sanitized value |
| --- | --- |
| Failed block kind | `child-ref-lifecycle` |
| Failed block status | `failed` |
| Failed block run/action | `run 1 · start` |
| Failed block SHA-256 | `05dae5ec6bd66a5679d4a207896fe07eda2b277cb90ff661e268c9e24d015dfa` |

### Wrong-thread fail-closed

| Combination | Typed code | Bounded / no prompt-transcript dump |
| --- | --- | --- |
| Retry arbitrary/malformed thread | `ThreadNotFound` (`unknown-thread`) | `true` |

### Retry exact thread → terminal success

Retry named the exact opaque thread from the CRM result. Lineage preserved
(`priorOutcome: failed`), distinct attempt created (`run 2 · retry`), and the
failed child-ref line remained byte-identical.

| Observation | Sanitized value |
| --- | --- |
| New compact block state | `completed` |
| New compact block run/action | `run 2 · retry` |
| New compact block SHA-256 | `8003bcb036401b6fc2a492f8d4a25569b1dec997b5ff939fbf8a74427f616558` |
| Completed child-ref SHA-256 | `666e9504fb36c6f0820ed3761a36ee72f61b8f60eb7f62802964830d26dfd995` |
| Old failed child-ref unchanged | `true` (same SHA-256 still present) |
| Thread terminal status | `completed` |
| Pass marker | `TASK20G_RETRY_PASS_G16593` |

### Assertion matrix

| Assertion | Result | Sanitized evidence |
| --- | --- | --- |
| Fresh pane runs Pi 0.83.0 with exact `16593bf` npm artifact; unsafe override absent | **PASS** | Version/digests matched; override unset; shadow absent |
| Controlled shuttle-mini child tool-only finish → typed CRM | **PASS** | `ChildResponseMissing` / `tool-only` after `pwd` |
| Structured result has `retryable: true`, `recovery: retry`, opaque `thread` | **PASS** | Thread prefix `7eb76371…`; no prompt/transcript leak |
| Failed source block freezes with terminal error status/hash | **PASS** | Failed child-ref SHA above |
| Retry names exact thread, preserves lineage, distinct attempt, terminal success | **PASS** | run 2 · retry completed; marker seen |
| Failed block byte-identical after retry; thread completed | **PASS** | Failed SHA unchanged; status `completed` |
| Wrong arbitrary/malformed thread fails closed with typed bounded diagnostic | **PASS** | `ThreadNotFound` |
| `childSettlementMissingCount: 0`; checklist v3; subject/artifact/digests/host/run | **PASS** | Evidence record above |
| Cleanup: created pane closed; preexisting panes preserved; no rpc/lease leftovers | **PASS** | Remaining `w23:p79 w23:p70`; rpc `0`; no active lease |
| Focused delegation-tool / thread / response-contract / overlay tests + docs links from clean `16593bf` | **PASS** | `226` pass / `0` fail; docs links EXIT `0` |
| Unrelated overlay/CodeSight WIP preserved byte-for-byte | **PASS** | Pre/post SHA-256 baseline identical |

### Repository checks (detached `16593bf` worktree)

| Check | Result |
| --- | --- |
| Focused delegation-tool / thread-lifecycle / child-response-contract / child-overlay tests | **226 pass**, 0 fail |
| `bun run docs:check-links` | PASS |

### Exact outcome and cleanup

```text
PASS
```

Pre-existing panes at start: `w23:p79 w23:p70`. Created pane `w23:pBZ` closed.
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

## Historical FAIL record (pre-16593bf thread-handle gap)

Result: **FAIL**

This section preserves the earlier live attempt that observed retryable
`ChildResponseMissing` without a usable opaque thread handle / overlay retry
route. It does not override the `16593bf` PASS above.

### Verdict

The real child result was `ChildResponseMissing` with `retryable: true`, but the
settled child was not available through the documented history and overlay
route. The direct shortcut reported no matching child, and the child picker
reported that it was unavailable in the session. The projected failure also
did not provide a thread handle. A documented retry could not start, so this
run cannot prove that retry creates a new run while the old block stays frozen.

No other error was relabeled as `ChildResponseMissing`.

### Environment

Observed at `2026-08-06T09:06:27Z`.

| Check | Outcome |
| --- | --- |
| Requested existing pane matched | `true` |
| Workspace pane count | `1` |
| Pane created or split | `false` |
| Pi version | `0.83.0` |
| Weave status | `ready` |
| Active primary agent | `LOOM` |
| Health-only mode | `false` |
| Trusted npm provenance present | `true` |
| Unsafe provenance override present | `false` |
| pi-vim owned the editor before the run | `true` |
| Installed extension SHA-256 | `eda2f6193544fee382a8447e20333eb95fa663cb3a510422f1c465c24fa30d84` |

### Safe trigger

Source inspection showed that an ordinary child turn can send an authenticated
completed settlement without `assistantOutput`. The parent drains final events
and then classifies a missing non-whitespace terminal assistant message as
`ChildResponseMissing`. Exiting before settlement would instead produce
`ChildExitedUnexpectedly`, so this attempt did not terminate a process.

One controlled logical child ran a bounded, no-write turn. It completed with a
whitespace-only terminal assistant message.

| Check | Outcome |
| --- | --- |
| Controlled logical child count | `1` |
| Child process termination count | `0` |
| Parent error discriminator | `ChildResponseMissing` |
| Missing-response reason | `whitespace-only` |
| Retryable | `true` |
| Recovery | `retry` |
| Other terminal error observed | `false` |

### Retry route blocker

| Check | Outcome |
| --- | --- |
| Direct child shortcut found a matching child | `false` |
| Child picker available | `false` |
| Projected thread handle present | `false` |
| Documented retry offered | `false` |
| Retry started | `false` |
| New retry run observed | `false` |
| Old block compared after retry | `false` |

The exact visible blockers were `no matching child` and `Child picker is
unavailable in this session`. An internal identifier was not extracted and no
undocumented retry path was used.
