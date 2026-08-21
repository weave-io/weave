# Child-overlay scroll: root-cause diagnosis

Spec 33 (Pi adapter), plan Task 1. Diagnosis only. No production source file is
modified by this task.

- Subject commit: `3dde84e` (branch `feat/pi-native-child-stream-rendering`,
  working tree carries unrelated pre-existing dirty changes).
- Harness: the isolated Pi 0.83 harness from
  [`33-task-20-isolated-pi-083-harness-setup.md`](33-task-20-isolated-pi-083-harness-setup.md),
  root `~/.local/share/weave/task20-pi083-harness`.
  - `bun/install/global/node_modules/@earendil-works/pi-coding-agent` version
    `0.83.0` (verified through `require(...).version`).
  - `bun/install/global/node_modules/@earendil-works/pi-tui` from the same
    isolated install.
  - Global Pi on this machine is `0.84.1` and was not used for any library
    reading or probe below.
- Terminal context for the captured input bytes: a Herdr pane (`w23:pC0`,
  workspace `w23`, `viewport_rows` 31 after the split, `terminal_id`
  `term_658b59a7d86501f`) on macOS, with the Kitty keyboard protocol pushed by
  the capture script (`ESC [ >1u` then `ESC [ >5u`). The pane was closed after
  capture; `herdr pane get w23:pC0` returns
  `{"error":{"code":"pane_not_found",...}}`.
- Throwaway instrumentation lived only in `/tmp/wv-scroll-diag/` and
  `/tmp/wv-probe2.mjs`. Nothing was added under any tracked `src/`.

## Verdict

One proven root cause.

**Pi 0.83 silently removes Weave's raw terminal-input listener without changing
the extension UI-context object, and Weave's binder treats "same host object" as
"listener still installed". After that point the binder never re-installs the
listener, emits no diagnostic, and every overlay scroll frame falls through to
Pi's own editor paging route instead of reaching the mounted overlay.**

Task 2 must change exactly one production file:

- `packages/adapters/pi/src/child-overlay-terminal-input.ts`

The liveness guard in `bind()` and the identical guard in `retry()` are the
defect. Both are inside that file. No other production file needs to change to
restore scrolling.

## The route, as it actually exists in Pi 0.83

Read from the isolated harness, not from memory.

1. `pi-tui/dist/tui.js`
   - `inputListeners = new Set()` (line 117), `addInputListener(listener)`
     (line 443) returns an unsubscribe that deletes from that set.
   - `handleInput(data)` (line 550) runs, in order: OSC 11 background
     response, terminal color-scheme report, **the extension `inputListeners`
     loop (lines 557-571)**, cell-size response, the `shift+ctrl+d` debug key,
     overlay focus/visibility restore, and only then
     `this.focusedComponent.handleInput(data)` followed by
     `this.requestRender()`.
   - In the listener loop, `result?.consume` returns immediately and
     `result?.data` rewrites the frame.
   - So an extension listener genuinely does get the first look at every frame,
     ahead of Pi's own editor paging route. The design premise of
     `child-overlay-terminal-input.ts` is correct.

2. `pi-coding-agent/dist/modes/interactive/interactive-mode.js`
   - `createExtensionUIContext()` (line 1674) exposes
     `onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler)`
     (line 1680). `ui.onTerminalInput` therefore exists in 0.83; the binder's
     "host exposes no ui.onTerminalInput" degraded path is not what fires.
   - `addExtensionTerminalInputListener(handler)` (line 1643) calls
     `this.ui.addInputListener(handler)` and tracks the unsubscribe in
     `extensionTerminalInputUnsubscribers` (line 235).
   - `clearExtensionTerminalInputListeners()` (line 1651) unsubscribes every
     tracked listener and clears the set. It is called from exactly two places:
     `resetExtensionUI()` (line 1529) and `stop()` (line 5058).
   - `resetExtensionUI()` (line 1518) hides the extension selector, input and
     editor, calls `this.ui.hideOverlay()`, calls
     `clearExtensionTerminalInputListeners()`, clears footer, header, widgets
     and statuses, resets autocomplete providers, and clears the custom editor
     component. **It never calls `setUIContext`.**
   - `resetExtensionUI()` callers: the constructor's
     `runtimeHost.setBeforeSessionInvalidate(() => this.resetExtensionUI())`
     (line 270) and `handleReloadCommand()` (line 4431, the `/reload` command).
   - Pi owns an editor paging route of its own: `getEditorKeyDisplay("tui.editor.pageUp")`
     and `"tui.editor.pageDown"` (lines 4817-4818) and the help row
     `| pageUp / pageDown | Scroll by page |` (line 4856). This is where a
     dropped overlay scroll frame ends up.

3. `pi-coding-agent/dist/core/extensions/runner.js`
   - `createContext()` exposes `ui` as a getter:
     `get ui() { runner.assertActive(); return runner.uiContext; }`. It returns
     the **stored** object, so `ctx.ui` has stable identity for the lifetime of
     a binding.
   - `setUIContext(uiContext, mode)` (line 267) is the only assignment site for
     `runner.uiContext`. Across the whole 0.83 `dist/`, `setUIContext` is called
     from exactly one place: `core/agent-session.js:1805`,
     `runner.setUIContext(this._extensionUIContext, this._extensionMode)`, where
     `_extensionUIContext` was assigned at `agent-session.js:1743` from
     `bindings.uiContext`.
   - The only site that supplies a fresh context to that binding is
     `bindCurrentSessionExtensions()` (`interactive-mode.js:1216`). The other
     two `createExtensionUIContext()` call sites (line 1365 in
     `setupExtensionShortcuts`, line 1661 in `createProjectTrustContext`) build
     throwaway contexts that are never installed on the runner.

The consequence is exact: **`resetExtensionUI()` removes Weave's listener while
leaving `runner.uiContext` — and therefore `ctx.ui` — the same object.**

## The defect in Weave

`packages/adapters/pi/src/child-overlay-terminal-input.ts` decides whether a
listener is live by comparing the host object it last subscribed to against the
host object it can read now:

- `bind()`: `if (state.terminalInput !== undefined) { if (state.terminalInputHost === route.ui) return; ... }`
- `retry()`: `if (state.terminalInput !== undefined && state.terminalInputHost === readTerminalInputRoute()?.ui) return;`

The in-file comment states the assumption explicitly: *"A different UI context is
live, so Pi invalidated or reloaded the session since the handle was taken.
`resetExtensionUI` already ran `clearExtensionTerminalInputListeners`, so the old
listener is gone."* That inference only holds in the direction it was written.
`resetExtensionUI()` clearing listeners does **not** imply a new UI context, and
Pi 0.83 has a path that clears without rebinding. In that state:

- `state.terminalInput` is a stale, already-consumed unsubscribe closure,
- `state.terminalInputHost === ctx.ui` is still `true`,
- so both `bind()` and `retry()` return early, forever,
- and no diagnostic is appended, so `/weave:health` shows nothing wrong.

`child-inspection-runtime.ts` cannot rescue this. `registerOverlayKeys` (line
830) early-returns once `overlayKeysCell.status === "applied" && plan !== undefined`,
so its `terminalInput.bind(...)` (line 913) is unreachable after the first
success; `maybeRegisterOverlayKeys` (line 921) calls `terminalInput.retry(...)`
(line 928) on every later lifecycle call, which is precisely the call that the
identity guard neutralizes.

## Reproduction

`/tmp/wv-scroll-diag/route-e2e.ts` (throwaway, not committed) imports the real
`createChildOverlayTerminalInputBinder` and `normalizeChildOverlayScrollFrame`
from `packages/adapters/pi/src/child-overlay-terminal-input.ts` and drives them
against a host that reproduces the three Pi 0.83 semantics read above: a `ctx.ui`
getter returning one stored object, `onTerminalInput` delegating to a pi-tui
style `addInputListener`, and a `resetExtensionUI()` that clears listeners
without replacing the context. The frame fed in is the exact canonical PageUp
frame `\x1b[5~`.

```
$ bun /tmp/wv-scroll-diag/route-e2e.ts
normalize(\x1b[5~) = "\u001b[5~"
1. after first bind()                          listeners=1 route=extension deliveredScroll=1
2. after retry() (no host change)              listeners=1 route=extension deliveredScroll=1
-- resetExtensionUI(): pi cleared listeners, uiContext identity unchanged --
3. after resetExtensionUI, before retry        listeners=0 route=dropped   deliveredScroll=0
4. after retry() following resetExtensionUI    listeners=0 route=dropped   deliveredScroll=0
5. after bind() following resetExtensionUI     listeners=0 route=dropped   deliveredScroll=0
state.terminalInput bound? true | host===ctx.ui? true
diagnostics: []
```

Lines 4 and 5 are the failure: after Pi clears the listener, neither `retry()`
nor `bind()` re-installs one, the binder still reports itself bound, and the
diagnostic buffer stays empty. `deliveredScroll=0` means the mounted overlay
never receives the frame.

## Captured input bytes

Captured with `/tmp/wv-scroll-diag/capture.ts` in pane `w23:pC0` after pushing
`ESC [ >1u` and `ESC [ >5u`. Each line is one raw read from stdin.

| Input | Raw frame | JSON |
| --- | --- | --- |
| `herdr pane send-keys shift+up` | `ESC[1;2A` (len 6) | `"\u001b[1;2A"` |
| `herdr pane send-keys shift+down` | `ESC[1;2B` (len 6) | `"\u001b[1;2B"` |
| `herdr pane send-keys ctrl+shift+x` | `ESC[120;6u` (len 8) | `"\u001b[120;6u"` |
| `herdr pane send-text` with six sequences | `ESC[5~ESC[6~ESC[1;2:1AESC[1;2:3AESCOHESCOF` (len 30, one coalesced frame) | `"\u001b[5~\u001b[6~\u001b[1;2:1A\u001b[1;2:3A\u001bOH\u001bOF"` |

`ctrl+shift+x` arriving as the Kitty CSI-u form `ESC[120;6u` proves the
progressive-enhancement flags were active for the capture.

Two harness facts worth recording:

- `herdr pane send-keys` **cannot deliver PageUp, PageDown, Home or End.**
  `pageup`, `pagedown`, `home` and `end` are accepted without error but put zero
  bytes on the pane; `PageUp`, `Page_Up`, `prior`, `next`, `Home` and `End` are
  rejected with `{"error":{"code":"invalid_key","message":"unsupported key ..."}}`.
  Any earlier "live" overlay-paging evidence gathered through `send-keys` did not
  actually press those keys.
- `herdr pane send-text` delivers injected escape sequences **coalesced into one
  frame**, so it is not a substitute for discrete key presses.

## Checks required by the task

### Listener bind timing — this is the fault

Covered above. `registerOverlayKeys` binds once (line 913) and then early-returns
(lines 835-839); `maybeRegisterOverlayKeys` (line 921) calls `retry` (line 928)
on every later lifecycle call; `retry`'s host-identity guard makes that call a
no-op exactly when Pi has silently cleared the listener.

The mount path is not itself at fault. `extension.ts` `mountNativeOverlay`
(lines 5258-5350) sets `childOverlayCell.open = true` (line 5281), then inside
the `ctx.ui.custom` factory sets `childOverlayCell.tui`, calls
`maybeRegisterOverlayKeys(pi, overlayKeybindings, generation.id)`, calls
`bindOverlayKeyInterceptor(generation.id)`, builds the component, and assigns
`childOverlayCell.component = mounted` (line 5347). The ordering is correct; the
`retry` inside `maybeRegisterOverlayKeys` is simply neutralized.

### Dispatch fail-closed guards — correct, not the fault

`child-inspection-runtime.ts` `dispatchOverlayScroll` (line 643) returns `false`
when the session context is gone, when `activeGenerationId()` differs from the
caller's generation, when `childOverlayCell.open` is false, when the cell's
generation differs, when `component` is undefined, or when `component.handleInput`
throws. Each of those is a genuine "not delivered" condition and each leaves the
frame on its host route. In the reproduction the guards all pass and delivery
succeeds whenever a listener exists (`deliveredScroll=1` on lines 1 and 2).

One latent issue, out of scope for Task 2 and recorded here only: on the
extension-listener route pi-tui returns as soon as a listener consumes a frame,
so pi-tui's own post-`handleInput` `this.requestRender()` never runs.
`dispatchOverlayScroll` does not call `component.invalidate()` or
`tui.requestRender()` either. Repaint depends entirely on the component's own
`requestPaint()` (`child-overlay-component.ts:403`) reached through
`afterControllerOutcome` (line 416). That path does fire on a successful scroll,
so it is not the current failure, but it is the only thing keeping the consumed
route painting.

### Legacy / Kitty / SS3 frame encoding and release suppression — correct

Probed directly against the isolated harness's own pi-tui 0.83 with
`/tmp/wv-probe2.mjs`, using that package's `matchesKey` and `isKeyRelease`:

| Frame | `isKeyRelease` | `matchesKey` hits |
| --- | --- | --- |
| `\x1b[5~` (legacy PageUp) | `false` | `pageUp` |
| `\x1b[6~` (legacy PageDown) | `false` | `pageDown` |
| `\x1b[5;1:1~` (Kitty PageUp press) | `false` | `pageUp` |
| `\x1b[5;1:3~` (Kitty PageUp release) | **`true`** | `pageUp` |
| `\x1b[1;2A` (legacy Shift+Up) | `false` | `shift+up` |
| `\x1b[1;2:1A` (Kitty Shift+Up press) | `false` | `shift+up` |
| `\x1b[1;2:3A` (Kitty Shift+Up release) | **`true`** | `shift+up` |
| `\x1bOH` (SS3 Home) | `false` | `home` |
| `\x1b[H` | `false` | `home` |
| `\x1b[1~` | `false` | `home` |
| `\x1b[F` | `false` | `end` |
| `\x1bOF` (SS3 End) | `false` | `end` |
| `\x1b[4~` | `false` | `end` |
| `\x1b[1;1:1H` (Kitty Home) | `false` | `home` |
| `\x1b[1;1:1F` (Kitty End) | `false` | `end` |

`normalizeChildOverlayScrollFrame` therefore accepts legacy, disambiguated,
event-aware and SS3 encodings alike, and `isKeyRelease` suppresses releases
correctly. Encoding is **not** the root cause. The `MAX_SCROLL_FRAME_LENGTH`
bound of 32 is not reached by any real single-press frame (longest observed
above is 9 bytes).

One cosmetic finding, not a scroll failure: `SCROLL_ALIASES` maps semantic
`shift+up` and `shift+down` onto the canonical **PageUp / PageDown** frames, so
the `+1` / `-1` single-row branches of `scrollDelta` in
`child-overlay-scroll.ts` are unreachable from the terminal-input route. That is
deliberate per the alias comment, but it means `SCROLL_KEYS.shiftUp`
(`\x1b[1;2A`) and `SCROLL_KEYS.shiftDown` (`\x1b[1;2B`) are dead constants on
this route.

### Mounted-component delivery — correct, not the fault

`child-overlay-component.ts` `handleInput` (line 759) runs, in order: a
`finished || isKeyRelease(data)` guard, `handleSearchInput`,
`normalizeChildOverlayScrollFrame`, the key interceptor, `alt+enter`, `enter`,
`isControllerInput`, then the draft editor. The interceptor
(`child-overlay-keys.ts:880`) resolves a canonical scroll frame through
`PiChildOverlayKeyMachine.handleInput`, which falls through escape,
`classifyChildOverlayKey` and backspace to `ok({kind:"overlay-input"})`, and the
interceptor returns `false` for that outcome. So scroll frames pass the
interceptor and reach `handleControllerInput`, which calls
`handlePaginationEdge(...).andThen(() => controller.handleInput(data))`.
`controller.handleInput` (`child-overlay-controller.ts:577`) applies
`scrollDelta` before anything else and returns `{kind:"scroll"}`.

The one guard that could silently swallow scrolls here is
`if (inputBusy) return;` in `handleControllerInput` (line 579). `inputBusy` is
cleared on every observed settle path in that file, and it was not implicated in
the reproduction, so it is not the current failure — but it is the correct place
to look if scrolling ever stalls *intermittently* rather than completely.

### Extent clamping — correct, not the fault

`child-overlay-component.ts` `render` computes
`contentBudget = view.scrollOffset > 0 && transcriptBudget > 0 ? transcriptBudget - 1 : transcriptBudget`
and `scrollMax = Math.max(0, transcript.value.length - contentBudget)`, feeds it
to `controller.setScrollExtent(scrollMax)` (`child-overlay-controller.ts:438`),
then clamps `scrollOffset = Math.min(scrollOffset, scrollMax)`.
`applyMeasuredExtent` in `child-overlay-scroll.ts` re-clamps and recomputes
`liveTail = scrollOffset === 0`. `maxScrollRows` falls back to
`state.entries.length` only before the first measured render, which is the
documented bootstrap case. Nothing here drops a frame; it can only bound how far
an already-delivered scroll moves.

## Instruction for Task 2

Change `packages/adapters/pi/src/child-overlay-terminal-input.ts` so that
listener liveness is proven rather than inferred from host-object identity. The
guard must treat "same `ctx.ui` object" as insufficient evidence that the
listener is still installed, because Pi 0.83's `resetExtensionUI()` clears
listeners without replacing that object. Whatever mechanism Task 2 chooses, it
must keep the existing invariants: at most one listener per live host, release on
teardown, no unbounded diagnostic growth on a host that never exposes
`ui.onTerminalInput`, and no change to the frames the route claims.

## Limitations

- The reproduction drives the real Weave binder against a host model built from
  the Pi 0.83 sources quoted above. It is not a full interactive Pi 0.83 TUI
  session with a live delegated child. A full interactive run was not performed
  because `herdr pane send-keys` cannot deliver PageUp, PageDown, Home or End
  (evidence above), so the failing key press cannot be driven through the pane
  automation available here.
- Consequently this document proves the defect and the mechanism, but it does
  **not** independently observe how often `resetExtensionUI()` fires in a normal
  session. Its two callers are session invalidation
  (`setBeforeSessionInvalidate`, line 270) and `/reload` (line 4431). Task 2
  should confirm the frequency question if it matters for the fix's shape; it
  does not change what must be fixed.
- Library reading was done against the isolated harness install only. Note that
  the Weave workspace itself declares `@earendil-works/pi-tui`,
  `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` as
  `peerDependencies` and has no repo-local `node_modules/@earendil-works`, so
  `bun test` resolves `@earendil-works/pi-tui` to the **global** install
  (`/Users/jose/.bun/install/global/node_modules/@earendil-works/pi-tui`, the
  0.84 line), not to 0.83. Unit tests therefore never exercise the 0.83 library
  this diagnosis is about.
- The repaint gap noted under "Dispatch fail-closed guards" and the dead
  `shiftUp` / `shiftDown` constants noted under "encoding" are recorded as
  observations. Neither is the root cause and neither is in Task 2's scope.
