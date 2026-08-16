# Weave UI redesign real-harness live proof

Status: **INCOMPLETE — 9 of 17 matrix items proven**

Date: 2026-08-16

This record covers Task 18 of
[the Pi Weave UI redesign plan](../../../../.weave/plans/pi-weave-ui-redesign.md).
It follows [`docs/testing/adapter-verification.md`](../../../testing/adapter-verification.md).

Task 18 is **not** satisfied by this record. Eight matrix items are unproven and
one is partial. The unproven items are listed with their exact blockers. No
unproven item is recorded as a pass.

## Preconditions and deviations

| Field | Value |
| --- | --- |
| Plan requirement | Fresh full-extension interactive Pi `0.83` TUI |
| Harness actually used | Pi `0.84.2` |
| Deviation authority | The user explicitly approved Pi `0.84.2` because Pi `0.83` is unavailable |
| Claim scope | This is a Pi `0.84.2` proof. It is **not** a Pi `0.83` proof |
| Task 17 (Weft gate) | Explicitly waived by the user. Weft never returned findings, comments, or a verdict. A waiver is not an approval |
| Subject commit | `600bd88eec58d12360add389ead548e0e1aca019` |
| Mode | Interactive TUI, full extension set (not `--no-extensions`, not print, not RPC) |
| Trust | `trusted` |

## Build and installed bytes

The package was built with Bun from an isolated detached worktree checked out at
the exact subject commit. `bun install` mutated only `bun.lock`; that file was
restored before the build, and the worktree source tree was verified clean.

| Artifact | SHA-256 |
| --- | --- |
| Packed tarball (`bun pm pack`) | `d426d76456d3ccd7db1f7ae390b63fcb5213017f870764a984b1e778f859b717` |
| Built `dist/extension.js` | `b84a8b024ab6754b3cba244273a404e50e25b991304323599efaa944736cf22a` |
| Built `dist/index.js` | `728d735adb297c4eaad795881db1655df4931bbb241109ed9778bb3155ff0170` |
| Built `dist/cli.js` | `71c522584cdedb44abdee9e01019992d74bcfeb2f5105b5cb7cc3c31f1ec2c9f` |

### Loading mode and provenance

The machine runs the documented **local development symlink** mode: the Pi
extensions directory contains a symlink to the adapter package, and the Pi
launcher exports `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1`. That mode was
preserved. No npm artifact was installed and no global Pi setting was modified.

Because the adapter loads through an extensions-directory symlink rather than an
npm package, `pi list` reports no Weave package identity. `pi list` was run and
showed the other user packages with no Weave entry and no load error. Load was
therefore proven from the TUI's own startup resource inventory, which listed the
adapter's extension entry, together with the adapter's registered commands. This
is a deviation from the plan's `pi list` identity requirement and is a direct
consequence of the active development mode, which the acceptance told this run to
preserve.

The exact clean-build `dist` bytes were swapped into the symlinked package before
the first TUI started, so the loaded `dist/extension.js` digest equals the built
digest `b84a8b02…`. The working checkout's prior `dist` was backed up first and
restored byte-for-byte afterwards.

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
| Keybinding conflicts | Two bounded warnings reported that `alt+left` and `alt+right` were left with their existing Pi owners; Weave registered no replacement |

## Matrix results

Every scenario ran in a Herdr pane that this run created and closed. Panes are
identified by scenario, not by pane id.

| Item | Scenario | Result | Observation |
| --- | --- | --- | --- |
| a | bootstrap → reasoning → tool call → tool result frames | **Pass** | Frames observed in order: `STARTING` / `run 1 · bootstrap`, `run 1 · reasoning`, `run 1 · tool call` with a live tool row, `run 1 · responding`, `run 1 · settled`. The terminal tool-result row was read in the expanded card as a result row under its call |
| b | `Ctrl+O` expand showing the strip and nine rows, then collapse | **Pass** | `Ctrl+O` printed a status strip (`AT BOTTOM · child settled ↑ 15 rows above`) over exactly nine literal transcript rows, and the footer verb changed to `Ctrl+O collapse`. A second `Ctrl+O` restored the collapsed card and the `Ctrl+O details` verb |
| c | completed settlement with authoritative final text | **Pass** | Card showed `COMPLETED` with the child's own single-line final text and `run 1 · settled` |
| d | failed settlement with a safe reason, no stack or path | **Pass** | Card showed `FAILED` with `assistant error · details unavailable`, an expanded `provider` row carrying the same canonical line, and no stack frame, no filesystem path, and no provider payload |
| e | cancelled settlement naming the initiator | **Pass** | Parent `Escape` produced `CANCELLED` with `stopped by the parent · partial work kept · nothing verified` |
| f | queued / steered card frame | **Not proven** | `Alt+Enter` queued a follow-up and the child later acknowledged the queued text, so the queue path works end to end. The transient `steered` card frame was never captured; sampling at 300–350 ms never observed the `steered` phase or a `queue` row, and the row had left the nine-row ring by settlement |
| g | narrow terminal (about 50 columns) | **Pass** | At 48 columns the card kept the state word, the assignment row, and `Alt+I inspect child`, with one top and one bottom edge and no over-wide line |
| h | `Alt+I` picker → open child → header and rail | **Pass** | Picker listed the running child; `Enter` opened the overlay. Header printed `CHILD shuttle · claude-opus-5` once plus `delegated by loom`, and the rail printed `LIFECYCLE` (status, elapsed, turn, run, live), `WORK` (tool, result, target, queue, next, args), and `SPEND` (cost, in, out) |
| i | live tail, then `PageUp` / `Home`, then `End` restoring follow | **Not proven** | Live tail and the scroll-back indicators both render (`↑ 53 earlier row(s) · / to search` while following, `↓ 10 newer line(s) below — End follows output` while scrolled back). `PageUp`, `Home`, `End`, `Shift+Up`, `Shift+Down`, and `PageDown` sent through the harness produced no viewport movement and no indicator change, while `/` and `Esc` sent the same way did act. Blocker: scroll keys did not move the transcript in this environment; whether the cause is the adapter or the key encoding delivered by the pane driver was not isolated |
| j | `/` search, `n` / `N`, `Enter` jump, `Esc` twice | **Not proven** | `/` opened the search rail with `query`, `match`, and `kinds` fields, and `Esc` closed search without closing the overlay. Every query tried reported `match 0/0` and `no match in this transcript`, including a literal substring visible on screen at the time. `n` typed into the draft rather than advancing a match, so `n` / `N` and `Enter` jump could not be exercised. Blocker: search returned no matches for text present in the rendered transcript |
| k | `Alt+1..9`, `alt+h` / `alt+l`, `Backspace` to parent | **Not run** | Not exercised |
| l | `Enter` steer and `Alt+Enter` follow-up on a live child | **Not proven** | `Alt+Enter` queue was delivered and acknowledged by the child. `Enter` steer was submitted twice on a live child (the draft cleared each time) but the steered text never appeared in the child transcript and the child never acknowledged it. Blocker: `Enter` steer did not reach the child while a tool call was in flight |
| m | `q` → `y` / `n` confirmation | **Pass** | `q` opened `cancel shuttle at turn 1? y yes · n no · Esc keep running`; `n` returned to the live key row with the child still running; `q` then `y` cancelled the child and the overlay switched to the settled read-only state |
| n | settled child read-only, caretless field, `✕` keys | **Pass** | Settled overlay printed a `shuttle · settled · read-only` field containing `▪ read-only — this child has settled` with no caret, and the key row printed `✕ Enter steer · ✕ Alt+Enter queue · ✕ q cancel (confirm) · / search · Esc close` |
| o | historical child after a parent restart, with pagination and search | **Not run** | Not exercised. Blocked in practice by the item `j` search result |
| p | narrow / short terminal keeping the prompt row that says how to leave | **Not run** | Not exercised |
| q | Plan Rail above the editor, `Alt+A` cycling, no duplicate task footer | **Partial** | The Plan Rail rendered above the editor in every pane as `◆ WEAVE · LOOM · Alt+A cycle`, and `Alt+A` cycled the primary agent through `TAPESTRY` and back to `LOOM` with the rail updating each time. No duplicate task footer appeared. The plan name, task marks, `now`, and `next` rows were **not** proven: no plan or workflow was active in any test session |

Proven: `a`, `b`, `c`, `d`, `e`, `g`, `h`, `m`, `n` (9).
Partial: `q` (1).
Unproven: `f`, `i`, `j`, `l` (4).
Not run: `k`, `o`, `p` (3).

## Cleanup after every pane

The same three checks ran after closing each scenario pane, and all three passed
every time:

- the live pane inventory across all workspaces matched the pre-test baseline
  exactly, so only test-created panes were closed and every pre-existing pane was
  preserved;
- no Weave child process remained (`pgrep` for the adapter's RPC child command
  line returned nothing);
- `weave runtime status` reported `No active lease.`

## Fault injection and restoration

Two temporary changes were made to induce failure states. Both were reverted and
verified.

| Change | Restoration |
| --- | --- |
| The subject `dist` bytes replaced the working checkout's `dist` | Restored byte-for-byte; the three digests match the pre-test values recorded above |
| A temporary project-config model override was appended to induce a provider failure | Restored byte-for-byte; the file digest returned to `d024829f48e5223548df7cd0349119d7d77f45a0b2e5a61a6c6e16dcf755761e` and the file shows no working-tree change. The override did not produce the intended failure and was not the mechanism used for item `d` |

Item `d` was ultimately induced by driving a child past its context budget, which
produced a genuine terminal assistant error and therefore a genuine failed
settlement.

## Unrelated working-tree state

The unrelated config-activation work in the checkout was not staged, edited,
reformatted, or reverted by this run. The working tree still shows exactly the
same modified and untracked config-activation paths it had before the run.

## Blocker

Task 18 cannot be closed from this record. Eight of seventeen matrix items are
unproven or unrun, and three of them (`i`, `j`, `l`) failed against behavior the
adapter documentation states should work:

1. **Overlay scroll keys do not move the transcript.** `PageUp`, `PageDown`,
   `Shift+Up`, `Shift+Down`, `Home`, and `End` had no effect, while other keys
   delivered the same way did. This must be isolated to either the adapter's key
   matching or the driver's key encoding before item `i` can be judged.
2. **Overlay search reports no matches.** A query for a literal substring
   rendered on screen returned `match 0/0` and `no match in this transcript`.
   Items `j` and `o` depend on this.
3. **`Enter` steer did not reach a live child.** The draft cleared but the child
   never received or acknowledged the steered text, while `Alt+Enter` queue did
   reach it. Item `l` depends on this.

Items `k`, `o`, and `p` were not run.
