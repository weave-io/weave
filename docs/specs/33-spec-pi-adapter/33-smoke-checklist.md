# Pi child-session smoke checklist

Version: 3

This checklist covers the acceptance surfaces defined in
[Spec 33](33-spec-pi-adapter.md). A row is `Pending` until a real-harness Pi
`0.83.0` run records a proof under [`33-proofs/`](33-proofs/). Each row runs in a
fresh Herdr pane that the test creates and closes; pre-existing panes are never
touched. The driver uses disposable `XDG_DATA_HOME` and `PI_CODING_AGENT_DIR`
and project roots.

The Task 20 matrix ran as per-item live runs on Pi `0.83.0` under checklist
version 3, each bound to the subject and artifact recorded inside its own proof
file, never to one shared artifact. The `Proof` column names the exact file that
recorded the row. Proof files are sanitized: they record digests, counts, and
outcomes, never prompts or transcripts.

| ID | Requirement | Spec | Result | Proof |
|---|---|---|---|---|
| S040 | Compact block shows the latest meaningful fragment in a fixed 3-line tail while running | §6 | Pass | [`33-task-20-a-compact-live-settlement-proof.md`](33-proofs/33-task-20-a-compact-live-settlement-proof.md) |
| S041 | Compact block shows the assembled final response tail or error on settlement, and freezes prior-run blocks | §6 | Pass | [`33-task-20-a-compact-live-settlement-proof.md`](33-proofs/33-task-20-a-compact-live-settlement-proof.md) |
| S042 | Compact block renders safely at narrow widths, sanitizes terminal control sequences, and isolates render errors | §6 | Pending | not run in Task 20 |
| S043 | Overlay renders a live child transcript with live-tail, scroll disengage, resize, and expansion toggle | §7 | Pass | [`33-task20-b-overlay-live-steer-followup.md`](33-proofs/33-task20-b-overlay-live-steer-followup.md) |
| S044 | Overlay steers a running child with `Enter` and queues a follow-up with `Alt+Enter` | §7 | Pass | [`33-task20-b-overlay-live-steer-followup.md`](33-proofs/33-task20-b-overlay-live-steer-followup.md) |
| S045 | Overlay renders a historical child after parent restart with bounded pagination and search | §7 | Pass | [`33-task20-c-historical-restart-pagination-search-proof.md`](33-proofs/33-task20-c-historical-restart-pagination-search-proof.md) |
| S046 | Overlay keeps settled children read-only and never leaks focused input to the primary editor | §7 | Pass | [`33-task20-b-overlay-live-steer-followup.md`](33-proofs/33-task20-b-overlay-live-steer-followup.md) |
| S047 | Overlay falls back to the custom-editor path on renderer failure and restores pi-vim mode on unmount | §7, §16 | Pass | [`33-task20-m-pi-vim-coexistence-proof.md`](33-proofs/33-task20-m-pi-vim-coexistence-proof.md) |
| S048 | Picker lists all statuses with title precedence and active-first, newest-settled ordering | §8.2 | Pass | [`33-task20-d-picker-navigation-proof.md`](33-proofs/33-task20-d-picker-navigation-proof.md) |
| S049 | Named keys route correctly: `Alt+I`, `Alt+1..9`, sibling keys, empty `Backspace` parent-or-close | §8.1 | Pass | [`33-task20-d-picker-navigation-proof.md`](33-proofs/33-task20-d-picker-navigation-proof.md), [`33-task20-m-pi-vim-coexistence-proof.md`](33-proofs/33-task20-m-pi-vim-coexistence-proof.md) |
| S050 | Keybinding conflicts are reported and never overwrite user bindings | §8.1 | Pass | [`33-task20-m-pi-vim-coexistence-proof.md`](33-proofs/33-task20-m-pi-vim-coexistence-proof.md) |
| S051 | Double `Escape` within 750 ms opens cancel-subtree confirmation defaulting to Keep running; single `Escape` never falls through | §8.1 | Pass | [`33-task20-e-double-escape-cancel-proof.md`](33-proofs/33-task20-e-double-escape-cancel-proof.md) |
| S052 | Retry a retryable failed thread and a cancelled thread; new block per run, divider metadata recorded | §9 | Pass | [`33-task20-f-retry-continue-frozen-block-proof.md`](33-proofs/33-task20-f-retry-continue-frozen-block-proof.md) |
| S053 | Continue a completed thread with a required task; continue without a task is a validation error | §9 | Pass | [`33-task20-f-retry-continue-frozen-block-proof.md`](33-proofs/33-task20-f-retry-continue-frozen-block-proof.md) |
| S054 | Thread errors are structured: already-running, stale, integrity, not-retryable; capacity held while running and released on settlement | §9, §3 | Pending | not run in Task 20 |
| S055 | Empty, whitespace-only, thinking-only, and tool-only completions settle as retryable `ChildResponseMissing` with the transcript preserved | §10 | Pass | [`33-task20-g-child-response-missing-retryable-proof.md`](33-proofs/33-task20-g-child-response-missing-retryable-proof.md) |
| S056 | `--no-session` parent fails delegation with `PersistentParentSessionRequired` and creates zero session files | §11 | Pass | [`33-task20-j-no-session-readonly-proof.md`](33-proofs/33-task20-j-no-session-readonly-proof.md) |
| S057 | Read-only history, picker, and doctor remain available under a non-persistent parent and in health-only mode | §11, §15.1 | Pass | [`33-task20-j-no-session-readonly-proof.md`](33-proofs/33-task20-j-no-session-readonly-proof.md), [`33-task20-n-health-only-readonly-proof.md`](33-proofs/33-task20-n-health-only-readonly-proof.md) |
| S058 | Session transition prompts with default Stay, then cancels descendants and writes settlement to origin refs before switching | §12 | Pass | [`33-task20-h-transition-stay-cancel-switch-proof.md`](33-proofs/33-task20-h-transition-stay-cancel-switch-proof.md) |
| S059 | A new parent session shows no prior-session child data; fork/clone refs are excluded on origin mismatch | §4.3, §12 | Pass | [`33-task20-i-fork-clone-origin-exclusion-proof.md`](33-proofs/33-task20-i-fork-clone-origin-exclusion-proof.md) |
| S060 | Quit and reload perform bounded cancel then force-stop with no residual child process | §12 | Pending | not run in Task 20 |
| S061 | No child session appears in Pi `/resume` or in Pi's default session tree | §2 | Pass | [`33-task20-l-resume-exclusion-proof.md`](33-proofs/33-task20-l-resume-exclusion-proof.md) |
| S062 | Child sessions and cache use user-only permissions inside the contained root | §2, §5 | Pending | not run in Task 20 |
| S063 | `/weave:history` returns a bounded first page; `/weave:doctor` returns a sanitized report with no raw prompt or transcript | §15.1, §15.4 | Pass | [`33-task20-k-history-doctor-cli-proof.md`](33-proofs/33-task20-k-history-doctor-cli-proof.md) |
| S064 | `weave adapter pi children list/show` respect the 50/100+cursor bounds, stable JSON, and no paths by default | §15.3 | Pass | [`33-task20-k-history-doctor-cli-proof.md`](33-proofs/33-task20-k-history-doctor-cli-proof.md) |
| S065 | `weave adapter pi children delete` requires confirmation, appends a tombstone, and leaves the child listed as a tombstone | §2, §15.3 | Pass | [`33-task20-k-history-doctor-cli-proof.md`](33-proofs/33-task20-k-history-doctor-cli-proof.md) |
| S066 | Deleting a parent leaves orphan children readable through history and doctor | §2 | Pass | [`33-task20-k-history-doctor-cli-proof.md`](33-proofs/33-task20-k-history-doctor-cli-proof.md) |
| S067 | Missing required capability enters health-only mode with capability, version, contract, probe, mode, and remediation | §16 | Pass | [`33-task20-n-health-only-readonly-proof.md`](33-proofs/33-task20-n-health-only-readonly-proof.md) |
| S068 | Keep child content out of parent projections: bounded terminal output and numeric metadata only | §13 | Pending | not run in Task 20 |
| S069 | Reject exact structured `ChildSettlementMissing` for valid bounded or transferred output | §1, §14 | Pending | not run in Task 20 |

A passing report must record artifact SHA-256, subject SHA, exact host version,
checklist version, run attempt, `childSettlementMissingCount: 0`, and, for each
row, that the test-created pane was closed with no residual process, lease, or
pane. Every proof cited above records those fields.

`S042`, `S054`, `S060`, `S062`, `S068`, and `S069` stay `Pending`: Task 20 ran
no live scenario for them, and their automated coverage alone cannot close a
live row. The requirements that depend on them (`PI-INS`, `PI-PRI`, `PI-BND`,
`PI-OVR`, `PI-RCV`) therefore stay `pending` in
[`acceptance-manifest.json`](acceptance-manifest.json).
