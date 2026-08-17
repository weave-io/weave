# Pi child-session smoke checklist

Version: 7

This checklist covers the acceptance surfaces defined in
[Spec 33](33-spec-pi-adapter.md) and the geometry, drop order, and honesty rules
fixed by the [Weave UI design record](33-weave-ui-design.md). A row is `Pending` until a real-harness Pi
`0.84.1` run records a proof under [`33-proofs/`](33-proofs/), indexed by
[`33-proofs/README.md`](33-proofs/README.md). Every live row runs in a fresh
Herdr pane that the test creates and closes, with isolated Pi config, data,
session, and project roots. The driver records the exact subject, artifact and
dist hashes, package provenance, Pi version, commands, observations, and cleanup.

Rows citing [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md)
were proven on Pi `0.84.2` under an explicit user-approved version deviation,
because Pi `0.83` was unavailable. That record concludes `PASS` across two
attempts: the retry ran at subject `7596103` and observed sixteen of its
seventeen matrix items there, while the failed-settlement item is carried over
from the first attempt at `600bd88` and is marked as such wherever it is cited.
The user explicitly accepted that carry-over, because the repair between the two
subjects does not touch provider-error projection, settlement recording, or
failed-card rendering. No row below claims the failed card was observed at the
final bytes. `Partial` means part of the row was observed live and the rest was
not; the proof record names exactly which part.

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
must agree on the delegation card, the live and historical child inspector, the
custom-editor fallback, and the parent-facing summary;
a later success must clear it. Raw input and sentinel values must remain absent.
General DLP for secret-shaped tool call IDs and credentials in ordinary tool
output is outside this acceptance scope.

## Weave UI redesign surfaces (rows S040–S043, S076–S077, S078–S080)

Version 7 replaces the three-line compact `weave_delegate` block with the inline
**delegation card** and the earlier overlay chrome with the **child inspector**.
The surfaces a proof must name are:

- **Delegation card** (§6): one framed card per run, status-first ten-column
  rail, one assignment row, one Native Line, and a balanced edge footer whose
  right side prints `Ctrl+O expand · Alt+I inspect child`. Expanded, one
  interior rule, one status strip, and nine literal bottom transcript rows.
  Settlement rewrites the rail word, the Native Line, and the footer verb
  (`expand` → `details`) and adds no row.
- **Child inspector** (§7): one titled outer frame with the live state marker;
  a two-row session header (badge · agent · model · role · bounded title, then
  `delegated by <PARENT>` · plan › task › subtask); a Pi-native transcript pane
  left; a Status Matrix rail right grouped lifecycle · work · spend; and a
  primary-like editor with one muted key row below.
- **Keys** (§8.1): `Alt+I` picker, `Alt+1..9`, sibling navigation on `Alt+H` /
  `Alt+L` with the arrow forms normally skipped by conflict detection, empty
  `Backspace` parent-or-close, the six scroll keys, `Enter` steer and
  `Alt+Enter` follow-up, empty-draft `q` cancel confirmation answered
  in-overlay with `y` / `n`, empty-draft `/` rail search with `n` / `N`
  (`j` / `k`) and `Enter` accept, and `Escape` following the precedence
  **cancel confirmation › search › overlay**. The `Ctrl+F` search alias is
  routed only when the host does not already own the key. `Ctrl+O` belongs to
  Pi's own tool expand and is never registered by Weave, and `Alt+A` / `Alt+T`
  do not route while the overlay owns input.
- **Plan Rail** (design record §4): the widget above the parent editor carrying
  `◆ WEAVE · <AGENT>`, the `Alt+A cycle` hint, the plan name, task marks with
  the ordinal, `┃ now`, and `┗ next`, with no duplicate task footer beside it.

## Overlay UX live procedure (rows S051, S070–S080)

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
   confirmation whose first and default choice is `Keep running`, answered
   inside the overlay. Press `n`; expect the child to keep running. Press `q`
   again and dismiss with `Escape`; expect the child to keep running and the
   overlay to stay mounted. Press `q` a third time and press `y` for
   `Cancel subtree`; expect the child to settle as `cancelled` and the lease to
   release. Confirm any other key is swallowed while the question is open.
5. **`q` draft and read-only (`S074`).** Type `hi` into the overlay draft, then
   press `q`. Expect `hiq` in the draft and no confirmation. Open a settled
   child, clear the draft, and press `q`. Expect no confirmation.
6. **Telemetry (`S075`).** On a live child that has reported usage, read the
   Status Matrix rail. Expect the lifecycle, work, and spend groups to carry
   real provider, model, context percentage, token, elapsed, queue, turn, and
   spend values. Confirm the session header shows the model exactly once and
   carries no telemetry row and no child ID. Open a child with no usage report
   and expect `—` in each unreported field, with no `0%` and no invented model.
7. **Rail search (`S076`).** With an empty overlay draft, press `/`. Expect a
   SEARCH section prepended to the Status Matrix and a marker gutter beside the
   transcript. Press `n` and `N` (then `j` and `k`) and expect the rail cursor and
   the transcript window to move together. Press `Enter` and expect the jump to
   latch the anchor. Press `Escape` once and expect search to close with the
   overlay still mounted; press `Escape` again and expect the overlay to close.
   Type `hi` into the draft and press `/`; expect `hi/` in the draft and no
   search. Repeat on a historical child after restarting Pi.
8. **Conflict (`S077`).** Bind an overlay key in Pi's own keybindings, restart,
   and open a child. Expect the route to be skipped, the affordance to be absent
   from the key row, and one bounded diagnostic naming the existing owner.
   Confirm Weave registers no binding for `ctrl+o`. On a stock keymap, confirm
   the `ctrl+f` search alias is reported as skipped and that `/` still opens
   rail search on an empty draft.
9. **Delegation card (`S078`).** In the parent transcript, watch one
   `weave_delegate` call from bootstrap through reasoning, a tool call, and a
   tool result. Expect exactly one framed card with one top and one bottom edge,
   a ten-column status-first rail, one assignment row, one Native Line, and a
   footer ending in `Ctrl+O expand · Alt+I inspect child`. Press `Ctrl+O`; expect
   one interior rule, one status strip, and nine transcript rows. Press `Ctrl+O`
   again to collapse. Narrow the terminal to about 50 columns and expect the
   state word, the assignment, and `Alt+I` to survive.
10. **Card settlement (`S079`).** Observe a completed, a failed, and a cancelled
    run. Expect the settled card to have the same row count as the running card,
    the rail word and Native Line rewritten from the authoritative settlement,
    the footer verb reading `details`, and no added row, banner, or border
    verdict. Expect no stack frame, absolute path, or provider payload on the
    failed card, and no success claim on the cancelled one.
11. **Plan Rail (`S080`).** Confirm the Plan Rail is visible above the parent
    editor with the selected agent, the `Alt+A cycle` hint, the plan, the task
    marks, `now`, and `next`. Press `Alt+A` and expect the agent to cycle and the
    rail to update. Confirm no duplicate task footer, and confirm the rail shows
    no child ID, token count, cost, elapsed time, or queue depth in any child
    state. Press `Escape` and expect the rail to survive.
12. **Cleanup.** Close the overlay, quit Pi, and confirm no residual child process
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
| S040 | The delegation card shows the status-first rail, the assignment row, and one Native Line carrying the latest meaningful activity while running | §6 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) item `a` |
| S041 | The authoritative settlement rewrites the rail word, the Native Line, and the footer verb without changing the row count or adding chrome, and freezes prior-run cards | §6 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) items `c`, `e` at the retry bytes; item `d` carried over from the first attempt at `600bd88` |
| S042 | The card renders safely at narrow widths keeping state, assignment and `Alt+I`, sanitizes terminal control sequences, and degrades instead of failing | §6 | Partial | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) item `g` proves the 48-column render; control-sequence sanitization was not exercised live |
| S043 | The child inspector's titled outer frame leaves the parent UI visible, renders the live child transcript with the Status Matrix rail, and supports live-tail, resize, and PageUp/PageDown/Shift+Up/Shift+Down/Home/End with Kitty press frames but no release repeats | §7 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) item `h` proves the frame, transcript, and rail; item `i` proves all six scroll gestures, including the Kitty event-type shift arrows |
| S044 | The owned native editor shows its cursor and border, supports cursor movement and multiline input, steers with `Enter`, and queues a follow-up with `Alt+Enter` | §7 | Pass | [`33-true-overlay-owned-editor-proof.md`](33-proofs/33-true-overlay-owned-editor-proof.md) |
| S045 | Overlay renders a historical child after parent restart with bounded pagination and search | §7 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) item `o` |
| S046 | A terminal of 12 rows or fewer keeps the owned editor and bottom border visible; settled children remain read-only and focused input never reaches the primary editor | §7 | Pass | [`33-true-overlay-owned-editor-proof.md`](33-proofs/33-true-overlay-owned-editor-proof.md) |
| S047 | Renderer failure uses the custom-editor fallback; normal overlay mount and unmount never replace the primary editor, and pi-vim remains usable after close | §7, §16 | Pending | [`33-true-overlay-owned-editor-proof.md`](33-proofs/33-true-overlay-owned-editor-proof.md) passes coexistence and teardown; no live renderer failure was injected |
| S048 | Picker lists all statuses with title precedence and active-first, newest-settled ordering | §8.2 | Pending | historical: [`33-task20-d-picker-navigation-proof.md`](33-proofs/33-task20-d-picker-navigation-proof.md) |
| S049 | Named keys route correctly: `Alt+I`, `Alt+1..9`, sibling keys, empty `Backspace` parent-or-close | §8.1 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) items `h`, `k` |
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
| S075 | The Status Matrix rail shows lifecycle, work, and spend for a reporting child, and `—` for every field the host did not report; the session header shows the model once and carries no telemetry row and no child ID | §7 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) item `h` |
| S076 | Empty-draft `/` opens rail search with the transcript marker gutter; `n`/`N` and `j`/`k` move, `Enter` latches the jump, and `Escape` closes search before the overlay, on live and historical children | §7, §8.1 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) items `j` (live) and `o` (historical). Search matches the ANSI-free rendered rows, so text that exists only in a tool row matches |
| S077 | A host that already owns an overlay key keeps it: the route is skipped, unadvertised, and reported once; Weave registers no binding for `Ctrl+O` | §8.1 | Pending | superseded surface; [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) records the removed `Ctrl+O` conflict route |
| S078 | The delegation card is one framed card with one top and one bottom edge at every width, expands to a status strip over nine literal bottom transcript rows, and prints `Ctrl+O expand · Alt+I inspect child` | §6 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) items `b`, `g` |
| S079 | Completed, failed, and cancelled cards keep the running row count, print the authoritative settlement text, expose no stack frame, path, or provider payload, and never claim unverified success | §6, §10 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) items `c`, `e` at the retry bytes; the failed card is item `d`, carried over from the first attempt at `600bd88` |
| S080 | The Plan Rail above the parent editor shows agent, `Alt+A cycle`, plan, task marks, `now`, and `next`; `Alt+A` cycles; it survives `Escape`; and it prints no child-operational fact and no duplicate task footer | §7 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) item `q` proves the plan name, marks, ordinal, `now`, `next`, `Alt+A` cycling, and the absence of a duplicate footer |

A passing report must record artifact SHA-256, subject SHA, exact host version,
checklist version, run attempt, `childSettlementMissingCount: 0`, and, for each
row, that the test-created pane was closed with no residual process, lease, or
pane. Every proof cited above records those fields.

`S042`, `S054`, `S060`, `S062`, `S068`, and `S069` stay `Pending`: Task 20 ran
no live scenario for them, and their automated coverage alone cannot close a
live row.

`S040`–`S043`, `S045`, `S049`, and `S075`–`S080` are closed by the Pi `0.84.2`
redesign proof, whose retry ran at subject `7596103`. One qualification stands:
the failed-settlement card (`S041`, `S079`) was observed only in that record's
first attempt, at subject `600bd88`; the retry could not induce a genuine
terminal provider failure and says so. Those two rows pass on evidence the user
explicitly accepted as chained across the two subjects, on the ground that the
repair leaves the provider-error, settlement, and failed-card paths unchanged —
not on a re-observation at the final bytes. `S042` stays `Partial` because
control-sequence sanitization was never exercised live, and `S077` stays
`Pending` because its `Ctrl+O` conflict route was removed with the old chrome.

`S051` and `S070`–`S074` cite the exact-subject evidence and the overlay key
matrix in `33-proofs/33-overlay-ux-live-proof.md`.

The rows marked `historical` stay `Pending` for a different reason: they need a
persistent child spawn or a native session mutation, which Pi `0.83.0` fails
closed. They cannot pass on this host.

Because of both groups, `PI-INS`, `PI-INT`, `PI-PRI`, `PI-BND`, `PI-OVR`,
`PI-SET`, `PI-RCV`, `PI-DEL`, `PI-LIF`, and `PI-QUO` are `pending` in
[`acceptance-manifest.json`](acceptance-manifest.json). The requirements that
remain `pass` rest on read-only, reporting, or automated evidence only.
