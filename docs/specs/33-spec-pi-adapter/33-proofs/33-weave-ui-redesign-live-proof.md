# Weave UI redesign real-harness live proof

Status: **PASS by accepted evidence chaining — 16 of 17 matrix items observed at
the tested bytes `7596103`, and item `d` carried over from the first attempt at
`600bd88`**

Date: 2026-08-16 (retry; supersedes the first attempt recorded the same day)

## Conclusion and the basis for it

This record concludes **PASS**. The conclusion rests on three separate facts,
and the reader should keep them separate:

1. Sixteen matrix items — `a`, `b`, `c`, `e`, `f`, `g`, `h`, `i`, `j`, `k`, `l`,
   `m`, `n`, `o`, `p`, `q` — were observed live at the exact subject bytes
   `7596103`.
2. Item `d`, the failed settlement, was observed live in its own fresh pane at
   the earlier subject `600bd88`. It was **not** re-observed at `7596103`. This
   retry could not induce a genuine terminal provider failure; the attempts and
   their real outcomes are recorded under “Item `d`: failure injection that did
   not reproduce”.
3. The repair between `600bd88` and `7596103` does not touch the code that item
   `d` exercises. The diff changes only
   `child-overlay-component.ts`, `child-overlay-controller.ts`,
   `child-overlay-input-modes.ts`, `child-overlay-pi-native.ts`,
   `child-overlay-search.ts`, `child-overlay-window.ts`, and
   `child-session-events.ts` (queue-event normalization), plus a regression
   test and docs. Provider-error projection (`child-provider-error.ts`,
   `child-provider-error-render.ts`), settlement recording
   (`delegation-controller.ts`, `repeated-settlement-validator.ts`), and failed
   card rendering (`child-card-model.ts`, `child-card-render.ts`) are byte-identical
   across the two subjects.

**The user explicitly accepted this chaining.** Presented with the choice, the
user selected “Accept carried-over proof (Recommended)”, which closes the only
remaining Task 18 blocker.

That acceptance is a decision about sufficiency, not a new observation. This
record does **not** claim that item `d` was re-observed at the final bytes, and
a reader who needs item `d` at `7596103` will not find it here.

This record covers Task 18 of
[the Pi Weave UI redesign plan](../../../../.weave/plans/pi-weave-ui-redesign.md).
It follows [`docs/testing/adapter-verification.md`](../../../testing/adapter-verification.md).

The first attempt proved nine items and reported three live blockers. Those
blockers were diagnosed against the live harness, two of them turned out to be
real adapter defects, and the third turned out to be a driver limitation. The
defects were repaired in commit `7596103`, which this record's bytes were built
from. The history of that first attempt is kept at the end of this record.

## Preconditions and deviations

| Field | Value |
| --- | --- |
| Plan requirement | Fresh full-extension interactive Pi `0.83` TUI |
| Harness actually used | Pi `0.84.2` |
| Deviation authority | The user explicitly approved Pi `0.84.2` because Pi `0.83` is unavailable |
| Claim scope | This is a Pi `0.84.2` proof. It is **not** a Pi `0.83` proof |
| Task 17 (Weft gate) | Explicitly waived by the user. Weft never returned findings, comments, or a verdict. A waiver is not an approval |
| Subject commit | `7596103cdbe65dab046206c31d4886984b1a2791` (`fix(pi): index the rendered transcript and read Pi 0.84 queue events`) |
| Mode | Interactive TUI, full extension set (not `--no-extensions`, not print, not RPC) |
| Trust | `trusted` |

## Build and installed bytes

The package was built with Bun from an isolated detached worktree checked out at
the exact subject commit. `bun install` mutated only `bun.lock`; that file was
restored before the build, and the worktree source tree was verified clean.

| Artifact | SHA-256 |
| --- | --- |
| Packed tarball (`bun pm pack`) | `882402c29f6f6b8dfd37f3f8adb9b860ad513127d6c4e836357b5917a01714fa` |
| Built `dist/extension.js` | `0fbd4e3f6c1fc917128d47427bb5ce1b23d4cefd8721121cb319083d6ca86758` |
| Built `dist/index.js` | `f23d55e645aa57b306f6f705233fc8da8e460d4073b1a48b8a03eef8cc2d5488` |
| Built `dist/cli.js` | `71c522584cdedb44abdee9e01019992d74bcfeb2f5105b5cb7cc3c31f1ec2c9f` |

### Loading mode and provenance

The machine runs the documented **local development symlink** mode: the Pi
extensions directory contains a symlink to the adapter package, and the Pi
launcher exports `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1`. That mode was
preserved. No npm artifact was installed and no global Pi setting was modified.

Because the adapter loads through an extensions-directory symlink rather than an
npm package, `pi list` reports no Weave package identity. Load was therefore
proven from the TUI's own startup resource inventory, which listed the adapter's
extension entry, together with the adapter's registered commands responding.
This is a deviation from the plan's `pi list` identity requirement and is a
direct consequence of the active development mode, which the acceptance told
this run to preserve. A release proof needs npm provenance instead.

The exact clean-build `dist` bytes were swapped into the symlinked package
before the first TUI started, so the loaded `dist/extension.js` digest equals the
built digest `0fbd4e3f…`. The working checkout's prior `dist` was backed up first
and restored byte-for-byte afterwards.

| Working-checkout `dist` file | SHA-256 before and after |
| --- | --- |
| `extension.js` | `e5fd7f43a1c38618bcbcfe7f898bcf6f73743e7eb3250ced778e7005b7725703` |
| `index.js` | `18e7f661945ad7f878fc582a4fcf269cc2079a643c3e65017db4df711efd3acd` |
| `cli.js` | `71c522584cdedb44abdee9e01019992d74bcfeb2f5105b5cb7cc3c31f1ec2c9f` |

## Load, readiness, and coexistence

Each claim below is separate. A load is not a readiness claim, and readiness is
not a behavior claim.

| Claim | Evidence observed in a fresh full-extension TUI |
| --- | --- |
| Load | The startup resource inventory listed the adapter's extension entry with no load error, and the adapter's slash commands responded |
| Readiness | `/weave:health` printed `Weave adapter mode: ready` with the capability list at its declared readiness |
| Session state | `/weave:status` printed `trust: trusted`, `mode: tui`, `health-only: false`, `children: 0` |
| pi-vim coexistence | After a deliberate delay following startup, a single `Escape` moved pi-vim from `INSERT` to `NORMAL` |
| Keybinding conflicts | Two bounded warnings reported that `alt+left` and `alt+right` were left with their existing Pi owners; one reported that `ctrl+f` stays with `tui.editor.cursorRight` and that `/` still opens search. Weave registered no replacement |

## Matrix results

Every scenario ran in a Herdr pane that this run created and closed. Panes are
identified by scenario, not by pane id.

| Item | Scenario | Result | Observation |
| --- | --- | --- | --- |
| a | bootstrap → reasoning → tool call → tool result frames | **Pass** | Footer frames observed in order: `run 1 · bootstrap`, `run 1 · tool call`, `run 1 · responding`, `run 1 · settled`. The terminal tool-result row was read in the expanded card as `⎿ bash done` under its call |
| b | `Ctrl+O` expand showing the strip and nine rows, then collapse | **Pass** | `Ctrl+O` printed a status strip (`AT BOTTOM · child settled ↑ 10 rows above`) over nine literal transcript rows and changed the footer verb to `Ctrl+O collapse`; a second `Ctrl+O` restored the collapsed card and `Ctrl+O details` |
| c | completed settlement with authoritative final text | **Pass** | Card showed `COMPLETED` with the child's own single line `COMPLETED-TEXT-ECHO` and `run 1 · settled` |
| d | failed settlement with a safe reason, no stack or path | **Carried over — not re-observed** | Proven in the first attempt at `600bd88` (card `FAILED`, `assistant error · details unavailable`, expanded `provider` row with the same canonical line, no stack, no path, no provider payload). This retry could not reproduce a genuine terminal provider failure: see “Item `d`: failure injection that did not reproduce” |
| e | cancelled settlement naming the initiator | **Pass** | Parent `Escape` produced `CANCELLED` with `⊘ stopped by the parent · partial work kept · nothing verified` |
| f | queued / steered card frame | **Pass** | `Alt+Enter` on a live child produced the retained card row `↯ queue  1 queued · parent steered the child` in the expanded card's viewport ring, plus the overlay transcript row `↯ queue 1` and rail `queue 1` / `live 1 queued`. The row is a retained ring row, so it is observable without sampling a transient phase |
| g | narrow terminal (about 50 columns) | **Pass** | At 48 columns the card kept the state word `RUNNING`, the assignment row, and `Alt+I inspect child`, with one top and one bottom edge and no over-wide line |
| h | `Alt+I` picker → open child → header and rail | **Pass** | Picker listed the running child; `Enter` opened the overlay. Header printed `CHILD shuttle · claude-opus-5` once plus `delegated by loom`, and the rail printed `LIFECYCLE` (status, elapsed, turn, run, live), `WORK` (tool, result, target, queue, next, args), and `SPEND` (cost, in, out) |
| i | live tail, then `PageUp` / `Home`, then `End` restoring follow | **Pass** | From `↑ 24 earlier row(s) · / to search`: two `PageUp` presses moved the viewport to `↓ 20 newer line(s) below — End follows output`; `Home` reached the oldest row (`↓ 24 newer`); `PageDown` moved to `↓ 14 newer`; `Shift+Up` and `Shift+Down` paged the same way; `End` restored follow. Frames were delivered as the terminal really encodes them, including the Kitty event-type forms `ESC [ 1;2:1 A` / `ESC [ 1;2:1 B` |
| j | `/` search, `n` / `N`, `Enter` jump, `Esc` twice | **Pass** | `/` opened the search rail. A query for text that exists only in a rendered tool row (`bash(command: echo delta-four)`) reported `match 1/1`; `echo charlie-three` reported `1/2`; `printed` reported `1/4` with `kinds assistant 4`. `Enter` latched the jump and the transcript moved onto the match (`↑ 10 earlier row(s)`); `n` advanced to `2/4` and `N` returned to `1/4`. The first `Esc` closed search and left the overlay open; the second closed the overlay |
| k | `Alt+1..9`, `alt+h` / `alt+l`, `Backspace` to parent | **Pass** | With two live siblings, `Alt+2` and `Alt+1` selected slots directly, `alt+l` moved to the next sibling and `alt+h` back. `Backspace` on a direct child returned to the parent by closing the overlay, which is the documented behaviour for a child with no parent child above it |
| l | `Enter` steer and `Alt+Enter` follow-up on a live child | **Pass** | `Enter` steer delivered `STEER-ONE-CHARLIE` and `Alt+Enter` queued `FOLLOWUP-TWO-DELTA` on the same live child. The rail showed `queue 1` then `queue 2` and the transcript showed `↯ queue 1` / `↯ queue 2`; the child's own reasoning and final report named both messages in order |
| m | `q` → `y` / `n` confirmation | **Pass** | `q` opened `cancel shuttle at turn 1? y yes · n no · Esc keep running`; `n` returned to the live key row with the child still `LIVE`; `q` then `y` cancelled the child and the overlay switched to the settled read-only state |
| n | settled child read-only, caretless field, `✕` keys | **Pass** | Settled overlay printed a `shuttle · settled · read-only` field containing `▪ read-only — this child has settled` with no caret, and the key row printed `✕ Enter steer · ✕ Alt+Enter queue · ✕ q cancel (confirm) · / search · Esc close` |
| o | historical child after a parent restart, with pagination and search | **Pass** | Pi was quit and restarted with `pi --session <id>`. `Alt+I` listed the completed child, the overlay rebuilt its transcript, `Home` / `PageDown` / `End` paged it, and `/ hist-charlie` reported `match 1/4` with `kinds user 1 · assistant 2 · tool 1`; `n` advanced to `2/4` |
| p | narrow / short terminal keeping the prompt row that says how to leave | **Pass** | At 48 columns and 15 rows the overlay rendered with the folded rail (`life`, `work`, `queue`) and kept the leave row `✕ Enter steer · ✕ q cancel · Esc close`. At 48 columns and 21 rows the live form kept `Enter steer · q cancel · Esc close`. Below the declared minimum terminal the overlay hides itself instead of drawing a corrupted frame, which is what the pane at 13 reported rows did |
| q | Plan Rail above the editor, `Alt+A` cycling, no duplicate task footer | **Pass** | With an engine-managed workflow tracked, the rail printed `◆ WEAVE · LOOM · Alt+A cycle · tapestry-execution`, the marks row `● ◐ ○   2/3`, `┃ now   Print the word RAILPROBE-TWO`, and `┗ next  Print the word RAILPROBE-THREE`. `Alt+A` cycled to `TAPESTRY` and back to `LOOM` with the rail updating each time. Exactly one rail row, one `now` row, one `next` row, and no task footer were present |

Proven at the tested bytes `7596103`: `a`, `b`, `c`, `e`, `f`, `g`, `h`, `i`,
`j`, `k`, `l`, `m`, `n`, `o`, `p`, `q` (16).
Carried over from the first attempt at `600bd88`, and accepted by the user as
sufficient on the unchanged-path rationale above: `d` (1).

## Cleanup after every pane

The same three checks ran after closing each scenario pane, and all three passed
every time:

- the live pane inventory across all workspaces matched the pre-test baseline
  exactly, so only test-created panes were closed and every pre-existing pane was
  preserved;
- no Weave child process remained;
- `weave runtime status` reported `No active lease.`

## Item `d`: failure injection that did not reproduce

Two injections were attempted in this retry, and both were reverted:

| Injection | Observed result |
| --- | --- |
| A temporary project-config `agent shuttle { models [...] }` override | The child still ran on `claude-opus-5`, so the override never reached the child and induced no failure. This repeats the first attempt's finding |
| A temporary `settings.adapters.pi.child_lifecycle.absolute_runtime_budget_ms` of 20 s, then 90 s, against a 200 s child | The child was stopped with `ChildRuntimeExceeded`, and the card rendered `delegation card unavailable · absent` rather than a `FAILED` card. This matches the first attempt's process-kill finding: a tool-boundary failure is not a child settlement failure |

Attempts to drive the child past its context budget did not fail it either: Pi's
tool layer truncates large `bash` and `read` results, and the child compacted
rather than erroring at 265k reported tokens.

Item `d` therefore remains proven only by the first attempt, against `600bd88`.
The provider-error projection, the settlement record, and the card's failed
rendering are untouched by the repair commit — the diff is confined to the
overlay files and queue-event normalization listed in “Conclusion and the basis
for it” — but this record does not claim them as re-observed at `7596103`.

The user reviewed exactly this gap and chose to accept the carried-over proof
rather than hold Task 18 open for a failure this harness would not reproduce.

## Restoration

| Change | Restoration |
| --- | --- |
| The subject `dist` bytes replaced the working checkout's `dist` | Restored byte-for-byte; the three digests match the pre-test values recorded above |
| Two temporary `.weave/config.weave` fault injections | Restored byte-for-byte; the file digest returned to `d024829f48e5223548df7cd0349119d7d77f45a0b2e5a61a6c6e16dcf755761e` and the file shows no working-tree change |
| A throwaway plan file under `.weave/plans/` for item `q` | Deleted after the run. `.weave` is ignored, so the repository is unchanged |
| A durable workflow started for item `q` | Aborted through `/weave:abort`; `weave runtime status` reported `No active lease.` afterwards |

## Unrelated working-tree state

The unrelated config-activation work in the checkout was not staged, edited,
reformatted, or reverted by this run. The working tree still shows exactly the
same modified and untracked config-activation paths it had before the run.

## History: the first attempt's blockers and what they were

The first attempt (subject `600bd88`, record commit `e0798eb`) proved
`a`, `b`, `c`, `d`, `e`, `g`, `h`, `m`, `n`, left `f`, `i`, `j`, `l` unproven and
`k`, `o`, `p` unrun. Its three blockers were diagnosed live before this retry:

1. **“Overlay scroll keys do not move the transcript” — driver limitation, not
   an adapter defect.** The pane driver rejects `pageup`, `pagedown`, `home`,
   and `end` as key names, so those presses were never delivered. Instrumented
   live tracing showed that every scroll frame that is delivered — legacy
   `ESC [ 5 ~`, application `ESC [ H` / `ESC [ F`, and the Kitty event-type
   `ESC [ 1;2:1 A` — is normalized, dispatched, and applied by the controller.
   Item `i` above proves all six gestures on the same harness by sending the
   real frames. Regressions now pin those encodings, the SS3 `ESC O H` /
   `ESC O F` forms, and the ignored Kitty release frames.
2. **“Overlay search reports no matches” — real defect, fixed.** Search matched
   the overlay *window* entry's short text projection, where a tool entry
   carries only its tool name, while the reader was looking at rendered rows.
   `⚙ bash(timeout: 180)` on screen returned `match 0/0` live. The mounted
   component now reports the ANSI-free twin of the rows it painted, and the
   controller matches that index as well as the window text.
3. **“`Enter` steer did not reach a live child” — not reproducible; the visible
   symptom was a real defect in queue reporting, fixed.** Live tracing showed
   the steer RPC written and acknowledged by the child, and the child acting on
   it. What was missing was the evidence: Pi `0.84` emits
   `queue_update { steering, followUp }`, and the adapter read only
   `queue_change`, so a steered or queued child kept `queue 0` and never reached
   the card's `steered` frame. The host event is now normalized into the
   existing queue fact, which is what items `f` and `l` above observe.
