# Pi child-session smoke checklist

Version: 6

This checklist covers the acceptance surfaces defined in
[Spec 33](33-spec-pi-adapter.md). A row is `Pending` until a real-harness Pi
`0.84.1` run records a proof under [`33-proofs/`](33-proofs/), indexed by
[`33-proofs/README.md`](33-proofs/README.md). Every live row runs in a fresh
Herdr pane that the test creates and closes, with isolated Pi config, data,
session, and project roots. The driver records the exact subject, artifact and
dist hashes, package provenance, Pi version, commands, observations, and cleanup.

## Pi 0.84.1 native-session contract

Pi `0.84.1` provides native path sessions through `SessionManager.create` and
`SessionManager.open`. The adapter validates Pi's generated path, ID, parent,
working directory, and exact v3 header; exclusively writes the deferred header;
reopens and revalidates it; launches with both `--session` and `--session-dir`;
and removes inherited `PI_CODING_AGENT_SESSION_DIR`. Paths remain adapter-private.

Readiness exposes only `delegated-specialist-execution`. There is no descriptor
capability, `path-only-session-api` reason, or unsafe flag. A generation enters
health-only mode before mutation when the real preflight yields
`pi-session-api-unavailable`, `pi-session-root-unavailable`,
`pi-session-root-unsafe`, or `pi-process-unavailable`. The proof should exercise
each closed reason where a deterministic isolated fixture can do so without
altering the global Pi install.

The earlier Pi `0.83.0` descriptor-only acceptance model and its fail-closed
proofs are historical. Their observations remain intact, but their readiness
conclusion does not govern this checklist. Version 6 requires live Pi 0.84.1
evidence for native child create, streaming, settlement, continue, historical
reopen, direct workflow persistence, lifecycle, readiness-gated deletion, and
path non-disclosure.

Version 6 also adds sanitized child provider-error evidence. Controlled child
events must cover 429, 500 with no body, connection/timeout, and unknown JSON
without an actual provider outage or credential use. The canonical bounded line
must agree in full, compact, historical, fallback, and parent-summary surfaces;
a later success must clear it. Raw input and sentinel values must remain absent.
General DLP for secret-shaped tool call IDs and credentials in ordinary tool
output is outside this acceptance scope.

## Overlay UX live procedure (rows S051, S070–S077)

Run every step in one fresh Pi `0.84.1` TUI on a real PTY, through the exact
packaged adapter artifact, after confirming the loaded `dist/extension.js` and
`dist/index.js` SHA-256 values and package provenance. Delegate
one child that produces enough output to overflow the viewport, and open it with
`Alt+I`.

1. **Scroll (`S070`).** Press PageUp, PageDown, Shift+Up, Shift+Down, Home, and
   End. Expect: PageUp and Shift+Up move the viewport toward older output;
   PageDown and Shift+Down move it back; Home reaches the oldest loaded output;
   End re-engages the live tail. Repeat with the terminal in application cursor
   mode so Home and End arrive as `ESC O H` / `ESC O F`. Expect identical
   movement. Record that one physical press moves one step, never two, under
   Kitty event reporting.
2. **pi-vim coexistence (`S071`).** With pi-vim active, repeat step 1. Expect the
   same movement, then close the overlay and confirm pi-vim reaches NORMAL mode
   and accepts `i` for INSERT in the parent editor.
3. **Escape (`S051`, `S072`).** Press `Escape` once. Expect the overlay to close,
   the parent editor to take focus, and no cancel prompt. Run
   `weave runtime status` and confirm the child's lease is still held. Reopen the
   child and confirm it is still `running`.
4. **`q` confirm (`S073`).** With an empty overlay draft, press `q`. Expect a
   confirmation whose first and default choice is `Keep running`. Choose
   `Keep running`; expect the child to keep running. Press `q` again and dismiss
   the modal with `Escape`; expect the child to keep running. Press `q` a third
   time and choose `Cancel subtree`; expect the child to settle as `cancelled`
   and the lease to release.
5. **`q` draft and read-only (`S074`).** Type `hi` into the overlay draft, then
   press `q`. Expect `hiq` in the draft and no confirmation. Open a settled
   child, clear the draft, and press `q`. Expect no confirmation.
6. **Telemetry (`S075`).** On a live child that has reported usage, read the
   header meta row. Expect `provider · model · ctx N% · X in / Y out` with real
   values. Open a child with no usage report and expect `—` in each unreported
   field, with no `0%` and no invented model.
7. **Compact (`S076`).** Press `Ctrl+O` on the live child. Expect a `compact`
   header badge and one-line entry rows. Press `Ctrl+O` again and expect the full
   transcript with the viewport still anchored on the same entry. Type a draft,
   run a `Ctrl+F` search, toggle twice, and expect the draft and the search query
   and match position unchanged. Repeat both toggles on a historical child after
   restarting Pi.
8. **Conflict (`S077`).** Bind `ctrl+o` in Pi's own keybindings, restart, and open
   a child. Expect no compact help row, no toggle, and one bounded diagnostic
   naming the existing owner.
9. **Cleanup.** Close the overlay, quit Pi, and confirm no residual child process
   and no active Runtime Store lease. Close the pane the test created.


Rows `S057`, `S063`, `S064`, and `S067` were re-run live against the final
fail-closed head `9a8c64683f3e159a587119ee045dc60ae5a62e86` on Pi `0.83.0`, and
[`33-task21-final-head-fail-closed-proof.md`](33-proofs/33-task21-final-head-fail-closed-proof.md)
is their current record. It also records bounded and fail-closed native-session
reads and the fail-closed rejection of `weave_delegate`, `/weave:run`,
`/weave:start`, and `children.delete` with no child process, lease, ref, cache
mutation, or native child session. The Task 20
`(j)`, `(k)`, and `(n)` records are historical for pre-`c24182f` behaviour,
including their formerly passing mutation rows.

| ID | Requirement | Spec | Result | Proof |
|---|---|---|---|---|
| S040 | Compact block shows the latest meaningful fragment in a fixed 3-line tail while running | §6 | Pending | historical: [`33-task-20-a-compact-live-settlement-proof.md`](33-proofs/33-task-20-a-compact-live-settlement-proof.md) |
| S041 | Compact block shows the assembled final response tail or error on settlement, and freezes prior-run blocks | §6 | Pending | historical: [`33-task-20-a-compact-live-settlement-proof.md`](33-proofs/33-task-20-a-compact-live-settlement-proof.md) |
| S042 | Compact block renders safely at narrow widths, sanitizes terminal control sequences, and isolates render errors | §6 | Pending | not run in Task 20 |
| S043 | A centered four-sided overlay leaves the parent UI visible, renders the live child transcript, and supports live-tail, resize, expansion, and PageUp/PageDown/Shift+Up/Shift+Down/Home/End with Kitty press frames but no release repeats | §7 | Pending | [`33-true-overlay-owned-editor-proof.md`](33-proofs/33-true-overlay-owned-editor-proof.md) passes the overlay, resize, live-tail, and key matrix; a distinct visible expansion-toggle state was not recorded |
| S044 | The owned native editor shows its cursor and border, supports cursor movement and multiline input, steers with `Enter`, and queues a follow-up with `Alt+Enter` | §7 | Pass | [`33-true-overlay-owned-editor-proof.md`](33-proofs/33-true-overlay-owned-editor-proof.md) |
| S045 | Overlay renders a historical child after parent restart with bounded pagination and search | §7 | Pending | historical: [`33-task20-c-historical-restart-pagination-search-proof.md`](33-proofs/33-task20-c-historical-restart-pagination-search-proof.md) |
| S046 | A terminal of 12 rows or fewer keeps the owned editor and bottom border visible; settled children remain read-only and focused input never reaches the primary editor | §7 | Pass | [`33-true-overlay-owned-editor-proof.md`](33-proofs/33-true-overlay-owned-editor-proof.md) |
| S047 | Renderer failure uses the custom-editor fallback; normal overlay mount and unmount never replace the primary editor, and pi-vim remains usable after close | §7, §16 | Pending | [`33-true-overlay-owned-editor-proof.md`](33-proofs/33-true-overlay-owned-editor-proof.md) passes coexistence and teardown; no live renderer failure was injected |
| S048 | Picker lists all statuses with title precedence and active-first, newest-settled ordering | §8.2 | Pending | historical: [`33-task20-d-picker-navigation-proof.md`](33-proofs/33-task20-d-picker-navigation-proof.md) |
| S049 | Named keys route correctly: `Alt+I`, `Alt+1..9`, sibling keys, empty `Backspace` parent-or-close | §8.1 | Pending | historical: [`33-task20-d-picker-navigation-proof.md`](33-proofs/33-task20-d-picker-navigation-proof.md), [`33-task20-m-pi-vim-coexistence-proof.md`](33-proofs/33-task20-m-pi-vim-coexistence-proof.md) |
| S050 | Keybinding conflicts are reported and never overwrite user bindings | §8.1 | Pass | [`33-task20-m-pi-vim-coexistence-proof.md`](33-proofs/33-task20-m-pi-vim-coexistence-proof.md) |
| S051 | `Escape` closes child inspection, never falls through to Pi, and leaves the child running | §7, §8.1 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S052 | Retry a retryable failed thread and a cancelled thread; new block per run, divider metadata recorded | §9 | Pending | historical: [`33-task20-f-retry-continue-frozen-block-proof.md`](33-proofs/33-task20-f-retry-continue-frozen-block-proof.md) |
| S053 | Continue a completed thread with a required task; continue without a task is a validation error | §9 | Pending | historical: [`33-task20-f-retry-continue-frozen-block-proof.md`](33-proofs/33-task20-f-retry-continue-frozen-block-proof.md) |
| S054 | Thread errors are structured: already-running, stale, integrity, not-retryable; capacity held while running and released on settlement | §9, §3 | Pending | not run in Task 20 |
| S055 | Empty, whitespace-only, thinking-only, and tool-only completions settle as retryable `ChildResponseMissing` with the transcript preserved | §10 | Pending | historical: [`33-task20-g-child-response-missing-retryable-proof.md`](33-proofs/33-task20-g-child-response-missing-retryable-proof.md) |
| S056 | `--no-session` parent fails delegation with `PersistentParentSessionRequired` and creates zero session files | §11 | Pending | historical: [`33-task20-j-no-session-readonly-proof.md`](33-proofs/33-task20-j-no-session-readonly-proof.md) |
| S057 | Read-only history, picker, and doctor remain available under a non-persistent parent and in health-only mode | §11, §15.1 | Pass | [`33-task21-final-head-fail-closed-proof.md`](33-proofs/33-task21-final-head-fail-closed-proof.md) |
| S058 | Session transition prompts with default Stay, then cancels descendants and writes settlement to origin refs before switching | §12 | Pending | historical: [`33-task20-h-transition-stay-cancel-switch-proof.md`](33-proofs/33-task20-h-transition-stay-cancel-switch-proof.md) |
| S059 | A new parent session shows no prior-session child data; fork/clone refs are excluded on origin mismatch | §4.3, §12 | Pending | historical: [`33-task20-i-fork-clone-origin-exclusion-proof.md`](33-proofs/33-task20-i-fork-clone-origin-exclusion-proof.md) |
| S060 | Quit and reload perform bounded cancel then force-stop with no residual child process | §12 | Pending | not run in Task 20 |
| S061 | No child session appears in Pi `/resume` or in Pi's default session tree | §2 | Pending | historical: [`33-task20-l-resume-exclusion-proof.md`](33-proofs/33-task20-l-resume-exclusion-proof.md) |
| S062 | Child sessions and cache use user-only permissions inside the contained root | §2, §5 | Pending | not run in Task 20 |
| S063 | `/weave:history` returns a bounded first page; `/weave:doctor` returns a sanitized report with no raw prompt or transcript | §15.1, §15.4 | Pass | [`33-task21-final-head-fail-closed-proof.md`](33-proofs/33-task21-final-head-fail-closed-proof.md) |
| S064 | `weave adapter pi children list/show` respect the 50/100+cursor bounds, stable JSON, and no paths by default | §15.3 | Pass | [`33-task21-final-head-fail-closed-proof.md`](33-proofs/33-task21-final-head-fail-closed-proof.md) |
| S065 | `weave adapter pi children delete` requires confirmation, appends a tombstone, and leaves the child listed as a tombstone | §2, §15.3 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S066 | Deleting a parent leaves orphan children readable through history and doctor | §2 | Pending | historical: [`33-task20-k-history-doctor-cli-proof.md`](33-proofs/33-task20-k-history-doctor-cli-proof.md) |
| S067 | Missing required capability enters health-only mode with capability, version, contract, probe, mode, and remediation | §16 | Pass | [`33-task21-final-head-fail-closed-proof.md`](33-proofs/33-task21-final-head-fail-closed-proof.md) |
| S068 | Keep child content out of parent projections: bounded terminal output and numeric metadata only | §13 | Pending | not run in Task 20 |
| S069 | Reject exact structured `ChildSettlementMissing` for valid bounded or transferred output | §1, §14 | Pending | not run in Task 20 |
| S070 | All six scroll keys move the mounted overlay viewport live, in legacy, Kitty event-aware, and SS3 encodings, with no release repeats | §7 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S071 | Scroll keys still move the overlay when a foreign primary editor (pi-vim) is installed, and pi-vim keeps its modes after close | §7, §16 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S072 | `Escape` closes the overlay and the inspected child is still running afterwards | §7, §8.1 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S073 | Empty-draft `q` opens the cancel confirmation; **Cancel subtree** cancels, and dismissal or **Keep running** leaves the child running | §8.1 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S074 | Non-empty draft `q` types into the draft and opens no confirmation; a settled child reports no target | §8.1 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S075 | Header telemetry shows provider, model, context percent, and tokens on a reporting child, and `—` for every field the host did not report | §7 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S076 | `Ctrl+O` toggles compact and full view on live and historical children, preserving draft, search state, and viewport anchor | §7, §8.1 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S077 | A host that already owns `Ctrl+O` keeps it: the toggle is skipped, unadvertised, and reported once | §8.1 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |

A passing report must record artifact SHA-256, subject SHA, exact host version,
checklist version, run attempt, `childSettlementMissingCount: 0`, and, for each
row, that the test-created pane was closed with no residual process, lease, or
pane. Every proof cited above records those fields.

`S042`, `S054`, `S060`, `S062`, `S068`, and `S069` stay `Pending`: Task 20 ran
no live scenario for them, and their automated coverage alone cannot close a
live row.

`S051` and `S070`–`S077` cite the exact-subject evidence and the full overlay
matrix in `33-proofs/33-overlay-ux-live-proof.md`.

The rows marked `historical` stay `Pending` for a different reason: they need a
persistent child spawn or a native session mutation, which Pi `0.83.0` fails
closed. They cannot pass on this host.

Because of both groups, `PI-INS`, `PI-INT`, `PI-PRI`, `PI-BND`, `PI-OVR`,
`PI-SET`, `PI-RCV`, `PI-DEL`, `PI-LIF`, and `PI-QUO` are `pending` in
[`acceptance-manifest.json`](acceptance-manifest.json). The requirements that
remain `pass` rest on read-only, reporting, or automated evidence only.
