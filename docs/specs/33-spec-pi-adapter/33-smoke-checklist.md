# Pi child-session smoke checklist

Version: 3

This checklist covers the acceptance surfaces defined in
[Spec 33](33-spec-pi-adapter.md). Rows are pending until the real-harness Pi 0.83
run records a proof under `33-proofs/`. Each row runs in a fresh Herdr pane that
the test creates and closes; pre-existing panes are never touched. The driver
uses disposable `XDG_DATA_HOME` and `PI_CODING_AGENT_DIR` and project roots.

| ID | Requirement | Spec | Result |
|---|---|---|---|
| S040 | Compact block shows the latest meaningful fragment in a fixed 3-line tail while running | §6 | Pending |
| S041 | Compact block shows the assembled final response tail or error on settlement, and freezes prior-run blocks | §6 | Pending |
| S042 | Compact block renders safely at narrow widths, sanitizes terminal control sequences, and isolates render errors | §6 | Pending |
| S043 | Overlay renders a live child transcript with live-tail, scroll disengage, resize, and expansion toggle | §7 | Pending |
| S044 | Overlay steers a running child with `Enter` and queues a follow-up with `Alt+Enter` | §7 | Pending |
| S045 | Overlay renders a historical child after parent restart with bounded pagination and search | §7 | Pending |
| S046 | Overlay keeps settled children read-only and never leaks focused input to the primary editor | §7 | Pending |
| S047 | Overlay falls back to the custom-editor path on renderer failure and restores pi-vim mode on unmount | §7, §16 | Pending |
| S048 | Picker lists all statuses with title precedence and active-first, newest-settled ordering | §8.2 | Pending |
| S049 | Named keys route correctly: `Alt+I`, `Alt+1..9`, sibling keys, empty `Backspace` parent-or-close | §8.1 | Pending |
| S050 | Keybinding conflicts are reported and never overwrite user bindings | §8.1 | Pending |
| S051 | Double `Escape` within 750 ms opens cancel-subtree confirmation defaulting to Keep running; single `Escape` never falls through | §8.1 | Pending |
| S052 | Retry a retryable failed thread and a cancelled thread; new block per run, divider metadata recorded | §9 | Pending |
| S053 | Continue a completed thread with a required task; continue without a task is a validation error | §9 | Pending |
| S054 | Thread errors are structured: already-running, stale, integrity, not-retryable; capacity held while running and released on settlement | §9, §3 | Pending |
| S055 | Empty, whitespace-only, thinking-only, and tool-only completions settle as retryable `ChildResponseMissing` with the transcript preserved | §10 | Pending |
| S056 | `--no-session` parent fails delegation with `PersistentParentSessionRequired` and creates zero session files | §11 | Pending |
| S057 | Read-only history, picker, and doctor remain available under a non-persistent parent and in health-only mode | §11, §15.1 | Pending |
| S058 | Session transition prompts with default Stay, then cancels descendants and writes settlement to origin refs before switching | §12 | Pending |
| S059 | A new parent session shows no prior-session child data; fork/clone refs are excluded on origin mismatch | §4.3, §12 | Pending |
| S060 | Quit and reload perform bounded cancel then force-stop with no residual child process | §12 | Pending |
| S061 | No child session appears in Pi `/resume` or in Pi's default session tree | §2 | Pending |
| S062 | Child sessions and cache use user-only permissions inside the contained root | §2, §5 | Pending |
| S063 | `/weave:history` returns a bounded first page; `/weave:doctor` returns a sanitized report with no raw prompt or transcript | §15.1, §15.4 | Pending |
| S064 | `weave adapter pi children list/show` respect the 50/100+cursor bounds, stable JSON, and no paths by default | §15.3 | Pending |
| S065 | `weave adapter pi children delete` requires confirmation, appends a tombstone, and leaves the child listed as a tombstone | §2, §15.3 | Pending |
| S066 | Deleting a parent leaves orphan children readable through history and doctor | §2 | Pending |
| S067 | Missing required capability enters health-only mode with capability, version, contract, probe, mode, and remediation | §16 | Pending |
| S068 | Keep child content out of parent projections: bounded terminal output and numeric metadata only | §13 | Pending |
| S069 | Reject exact structured `ChildSettlementMissing` for valid bounded or transferred output | §1, §14 | Pending |

A passing report must record artifact SHA-256, subject SHA, exact host version,
checklist version, run attempt, `childSettlementMissingCount: 0`, and, for each
row, that the test-created pane was closed with no residual process, lease, or
pane.
