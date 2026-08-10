# Pi Child Overlay UX Feedback: Scroll Fix, Escape/Cancel Semantics, Telemetry Header, Compact Mode

## TL;DR
Fix live overlay scrolling with a root-cause diagnosis and regression proof, change Escape to exit inspection without cancelling, move child cancellation behind an explicit `q` confirmation, add an authoritative provider/model/context/token header with honest unavailable states, and add a compact child-view toggle — all inside the existing true-overlay, bounded, neverthrow, pi-vim-safe architecture.

## Context
The Pi adapter's child overlay lives in `packages/adapters/pi/src`:

- `child-overlay-component.ts` — `ui.custom` component. Input routing order: search (`ctrl+f`, trigger `\x06`) → key interceptor → Escape/finish → Enter/Alt+Enter → controller scroll keys (`isControllerInput`) → draft `CustomEditor`. `PI_CHILD_OVERLAY_CUSTOM_OPTIONS` (`overlay:true`, center, 90%/90%, margin 1) is pinned by test; `overlayUsableRows` protects the editor and bottom border on short terminals.
- `child-overlay-controller.ts` (`handleInput` at ~577) — maps `scrollDelta` (page ±10, shift ±1, home→"oldest", end→"follow"), Enter→steer, Alt+Enter→follow-up, ctrl+e expansion, alt+arrows run/branch nav; all other bytes are consumed; the draft is owned by the overlay editor via `updateDraft`.
- `child-overlay-scroll.ts` — rendered-row scroll model; component measures `scrollExtent` via `setScrollExtent`; `maxScrollRows` falls back to `entries.length` before the first measurement.
- `child-overlay-terminal-input.ts` — ownership-independent `ui.onTerminalInput` route. While the overlay is open it claims exactly the six scroll frames, normalized with semantic `matchesKey` (Kitty event-aware), and delivers via `dispatchOverlayScroll`; `false` leaves the frame on the host route. `SCROLL_KEYS` raw frames: `\x1b[5~`, `\x1b[6~`, `\x1b[1;2A`, `\x1b[1;2B`, `\x1b[H`, `\x1b[F`.
- `child-inspection-runtime.ts` — `dispatchOverlayScroll` (~643) fails closed on stale session ctx, generation mismatch, `!childOverlayCell.open`, cell generation mismatch, or missing component, then calls `component.handleInput(canonical)`. `confirmCancelSubtree` (~772) shows `ctx.ui.select(CHILD_OVERLAY_ESCAPE_HINT, CHILD_OVERLAY_CANCEL_CHOICES)`; only an explicit "Cancel subtree" choice cancels via `delegationControllerCell.controller.cancelSubtree`.
- `child-overlay-keys.ts` — key machine. Current Escape semantics: first press arms `CHILD_OVERLAY_ESCAPE_HINT` ("Press Escape again to cancel this child subtree"), second press within `escapeWindowMs` (750 ms) yields `confirm-cancel-subtree`. Backspace with empty draft focuses the parent or closes the overlay. Interceptor consumes Escape/Backspace/planned keys; stale context swallows them with a report.
- `extension.ts` (~5263–5410) — `mountNativeOverlay` mounts via `ctx.ui.custom` with `PI_CHILD_OVERLAY_CUSTOM_OPTIONS`, registers overlay keys and binds the interceptor in the factory, sets `mounted.focused = true`, and never touches `setEditorComponent`. Fallbacks route to `activateCustomEditorInspection`.
- Telemetry sources today: `ChildOverlayView.child.model` (optional bounded label), metadata cache `latest_run_model`, and a parser-approved child event `event("usage", { usage: boundedJson.optional() })` in `child-session-events.ts` that nothing currently projects into the overlay. There is no provider, token, or context-window field anywhere in overlay types.
- `child-compact-render.ts` is the parent-transcript compact `weave_delegate` block (contract §6) — it is not an overlay view mode, but its bounded reduction style is the pattern to follow.

Normative docs: `docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md` §7 (overlay contract: legacy + Kitty frames for all six scroll keys, keyboard ownership while mounted, short-terminal row budget, mouse wheel out of contract), §8 (keys), §14 (stable diagnostic codes), plus `33-smoke-checklist.md`, `33-proofs/` (incl. `33-task20-e-double-escape-cancel-proof.md`, `33-task-20-isolated-pi-083-harness-setup.md`), `docs/adapters/pi.md`, and `docs/testing/adapter-verification.md`.

## Scope
- In scope:
  - Root-cause diagnosis and fix for live scroll failure in the mounted overlay, with Bun regression tests and a real Pi 0.83 proof.
  - Escape exits child inspection and returns to the parent without cancelling the child.
  - `q` (empty-draft gated) opens a cancellation confirmation; confirm cancels/kills the child subtree; cancel/dismiss/error leaves it running.
  - Overlay header telemetry: provider, model, context percentage, token counts, from authoritative bounded data with honest `—` / "unavailable" states.
  - Compact child-view mode with a clear toggle, preserved input/scroll behavior, and per-child bounded state.
  - Spec §7/§8/§14 updates, smoke-checklist and `docs/adapters/pi.md` updates, superseding the double-escape proof, new live proofs, full gates, Weft review.
- Out of scope:
  - Mouse-wheel scrolling (Pi does not enable mouse reporting; explicitly out of contract per §7).
  - Custom-editor fallback inspection parity for the new features beyond not regressing it.
  - Engine/core changes; any new delegation authority. Cancellation reuses the existing `delegationController.cancelSubtree` path.
  - Estimating tokens or context size when the host does not report them — no guessing.
- Constraints / assumptions:
  - Preserve pi-vim and primary-editor ownership: never touch `setEditorComponent`; `ui.custom` owns input while mounted; the terminal-input route stays conflict-checked and never steals host/user keys.
  - Typed `neverthrow` failures on every expected-failure path; no `console.*`; no throws.
  - All new state bounded with pinned constants; true-overlay geometry (`overlay:true` options) and `overlayUsableRows` short-terminal guarantees unchanged; settlement/generation guards (`activeGenerationId`, `childOverlayCell.generationId`, settle-once) unchanged.
  - Bun-only tests (`bun test`), mocks for the harness boundary, real-harness proof per `docs/testing/adapter-verification.md`.
  - Warp review is required only if Task 4 changes who may authorize cancellation or adds a new trust boundary; reusing the existing confirm→`cancelSubtree` authority does not require Warp.

## Objectives
- Scrolling works in the real mounted overlay under Pi 0.83 on a real PTY, with a written diagnosis, a regression test that fails on the old code, and a live proof.
- Escape = exit inspection, never cancel. `q` + explicit confirmation = cancel. No hidden destructive path remains.
- The overlay header shows provider, model, context %, and tokens when authoritative data exists, and honest placeholders when it does not.
- A compact view mode toggles clearly, preserves scroll/draft behavior, and stays within bounds.

## Dependencies and Order
1. Task 1 (diagnosis) must land first: the scroll fix (Task 2) must implement the proven root cause, not a guess.
2. Task 3 (Escape exit) precedes Task 4 (`q` cancel): Task 4 reuses the confirm machinery that Task 3 detaches from Escape, so sequencing avoids an intermediate state with no cancel path.
3. Task 5 (telemetry data model) precedes Task 6 (header rendering): rendering consumes the typed view fields Task 5 adds.
4. Task 7 (compact mode) depends on Task 2 (scroll must be correct before adding a second layout that shares the scroll model) and on Task 6 (header/help lines it must coexist with).
5. Task 8 (docs/spec/smoke) depends on all behavior tasks. Task 9 (gates, live proofs, reviews) is last.

## Tasks

- [x] 1. Diagnose the live scroll failure and write the root-cause note
  - **What**: Reproduce the broken scroll in a real mounted overlay and identify which route drops the frames. Do not fix production code yet; produce a written diagnosis with evidence.
  - **Files**: `docs/specs/33-spec-pi-adapter/33-proofs/33-overlay-scroll-diagnosis.md` (new; findings + evidence). Throwaway instrumentation only in the isolated harness, never committed to `src/`.
  - **Depends on**: None.
  - **Implementation outline**:
    1. Stand up the isolated Pi 0.83 harness per `33-proofs/33-task-20-isolated-pi-083-harness-setup.md`, mount the overlay on a live child, and press PageUp/PageDown/Shift+Up/Shift+Down/Home/End on a real PTY.
    2. Check each candidate route in order, capturing which one drops the frame:
       - Listener bind timing: is the `ui.onTerminalInput` listener actually bound when the overlay opens (binder `bind`/`retry` are driven by key registration; a degraded or never-run route leaves `status:'applied'` with no live listener)? Inspect `overlayKeysCell` diagnostics.
       - `dispatchOverlayScroll` fail-closed guards: stale `latestSessionCtx`, `activeGenerationId` mismatch, `childOverlayCell.open` false, `childOverlayCell.generationId` set to a stale generation, `component === undefined`.
       - Frame encoding: real terminals emit SS3 `\x1bOH`/`\x1bOF` for Home/End in application cursor mode, and Kitty event-aware forms (`\x1b[1;2:1A` etc.); verify `normalizeChildOverlayScrollFrame`'s `matchesKey` coverage for each of the six keys, plus release-frame suppression.
       - Component-route delivery: whether Pi 0.83 delivers any of these keys to the mounted `ui.custom` component at all (`mounted.focused`), and whether the host claims Shift+Up/Down or Home/End before both routes.
       - Extent clamping: whether `setScrollExtent` measurement during re-render clamps `scrollOffset` back toward 0 (offset applied, then immediately reset).
    3. Record: exact bytes received, the route that consumed or dropped each key, and the single proven root cause (or ranked causes if multiple).
  - **Pitfalls / non-goals**:
    - Do not "fix" by adding raw-byte comparisons; §7 requires semantic legacy + Kitty matching.
    - tmux/iTerm re-encode key frames; record which terminal produced each capture.
    - Diagnosis instrumentation must not ship: the committed artifact is the proof doc only.
  - **Acceptance**:
    - Proof doc exists, names one proven root cause with captured byte evidence, and states which file(s) Task 2 must change.
    - No production source files modified in this task's commit. Commit: `docs(pi): record child-overlay scroll root-cause diagnosis`.

- [x] 2. Fix overlay scrolling and add regression coverage
  - **What**: Implement the fix for the Task 1 root cause and lock it with Bun regression tests that fail on the pre-fix code.
  - **Files**: the file(s) named by Task 1 among `packages/adapters/pi/src/child-overlay-terminal-input.ts`, `child-inspection-runtime.ts`, `child-overlay-component.ts`, `child-overlay-scroll.ts`, `extension.ts`; tests in `packages/adapters/pi/src/__tests__/child-overlay-terminal-input.test.ts`, `__tests__/child-overlay-mount.test.ts`, and/or `__tests__/child-inspection-runtime.test.ts`.
  - **Depends on**: Task 1.
  - **Implementation outline**:
    1. Apply the minimal fix on the proven route (e.g., bind the terminal-input listener on overlay mount when absent; widen `normalizeChildOverlayScrollFrame` to the missing encodings; set/clear `childOverlayCell.generationId` correctly; or defer extent clamping across the scroll-then-render sequence — whichever Task 1 proved).
    2. Keep the exactly-once delivery contract: the listener consumes only frames `dispatchOverlayScroll` reports delivered; `false` leaves the frame on the host route.
    3. Add regression tests simulating the captured real-PTY byte sequences (legacy CSI, Kitty event-aware press + release, SS3 Home/End) end to end: listener → dispatch → controller state, asserting `scrollOffset` movement and release-frame suppression.
    4. Add a mount-order test if bind timing was the cause: overlay opened under a foreign primary editor (pi-vim scenario) must still have a live listener.
  - **Pitfalls / non-goals**:
    - Never register new raw shortcuts for scroll keys — that would steal host keys; the conflict-port rule stands.
    - Do not double-deliver when both the component route and the listener route see a frame; preserve the "listener claims scroll frames while open" invariant.
    - Preserve `pendingTailExtentAdjustment` semantics; do not reset `liveTail` incorrectly for offset > 0.
  - **Acceptance**:
    - New tests demonstrably fail on pre-fix code (note the check in the commit body) and pass post-fix.
    - `bun test packages/adapters/pi` passes; no new unbounded state.
    - Commit: `fix(pi): deliver overlay scroll frames on the proven live route` (adjust summary to the actual root cause).

- [x] 3. Make Escape exit child inspection without cancelling
  - **What**: Replace the double-Escape cancel arm/confirm flow: a single Escape closes the overlay and returns to the parent, leaving the child running. Search-mode Escape (cancel search) and any open confirm modal keep their local Escape meaning.
  - **Files**: `packages/adapters/pi/src/child-overlay-keys.ts` (key machine `handleEscape`, `CHILD_OVERLAY_ESCAPE_HINT`, outcomes), `child-inspection-runtime.ts` (interceptor deps), `child-overlay-component.ts` (no-interceptor Escape path already closes — verify unchanged), `__tests__/child-overlay-keys.test.ts`, `__tests__/child-inspection-runtime.test.ts`.
  - **Depends on**: None (but must merge before Task 4).
  - **Implementation outline**:
    1. Change `PiChildOverlayKeyMachine.handleEscape` to yield a single `close-overlay` outcome; delete arm/re-arm state, `escapeWindowMs` usage for cancel, and the `confirm-cancel-subtree` Escape trigger (keep the outcome type and `resolveChildOverlayCancelChoice` for Task 4).
    2. Route the interceptor's `close-overlay` to the existing overlay settle path (`closeOverlay` dep), which restores parent focus without touching the child lease.
    3. Preserve ordering in the component: search typing/navigate still consumes Escape first; interceptor Escape only fires when search is off.
    4. Update key-machine tests: single Escape → close; no hint arming; child still running afterward (runtime test asserts no `cancelSubtree` call).
  - **Pitfalls / non-goals**:
    - Do not remove the interceptor's stale-context swallow: Escape on a stale generation must stay consumed with a report, never leak to the primary editor.
    - The no-interceptor fallback path (`keybindings.matches('tui.select.cancel')`) already exits without cancel; keep it byte-identical.
    - Old proof `33-task20-e-double-escape-cancel-proof.md` becomes historical — supersede in Task 8, do not delete.
  - **Acceptance**:
    - Unit tests prove: Escape closes overlay, parent regains focus, zero cancellation side effects; Escape in search mode only exits search.
    - Commit: `feat(pi): make escape exit child inspection without cancelling`.

- [ ] 4. Gate child cancellation behind `q` with explicit confirmation
  - **What**: While inspecting a child, `q` with an empty draft opens a confirmation modal; only an explicit confirm cancels/kills the child subtree; cancel/dismiss/timeout/error leaves it running. With a non-empty draft, `q` types into the draft as today.
  - **Files**: `packages/adapters/pi/src/child-overlay-keys.ts` (key machine: `q` handling analogous to Backspace's empty-draft gating; rename hint constant), `child-inspection-runtime.ts` (`confirmCancelSubtree` wiring reused; prompt copy), `child-overlay-component.ts` (help line mentions `q`), `__tests__/child-overlay-keys.test.ts`, `__tests__/child-inspection-runtime.test.ts`.
  - **Depends on**: Task 3.
  - **Implementation outline**:
    1. In the key machine's `handleInput`, before falling through to `overlay-input`: if the byte is `q`/`Q` and the current context draft is empty, return the existing `confirm-cancel-subtree` outcome for the focused child; otherwise return `overlay-input` so the draft editor receives the character.
    2. Keep `resolveChildOverlayCancelChoice` fail-safe semantics: only the explicit cancel choice cancels; `undefined`, dismissal, and select errors keep the child running. Update choice copy to name the child (bounded via existing title truncation).
    3. Reuse `confirmCancelSubtree`'s generation guard (`activeGenerationId` recheck after the modal resolves) unchanged.
    4. Tests: `q` empty-draft → confirm outcome; `q` non-empty draft → overlay-input; confirm choice → `cancelSubtree` called exactly once; every other resolution → no call; stale generation after modal → no call.
  - **Pitfalls / non-goals**:
    - `q` must never be a registered shortcut — it stays inside the interceptor/machine so typing is unaffected and no host key is stolen.
    - Read-only (settled/orphan) children: confirm must be suppressed or the cancel becomes a no-op through the existing controller guard — pin whichever with a test.
    - No new authority: the modal still calls the existing `delegationController.cancelSubtree`. If review of this task adds any new trust surface (e.g., cancelling non-descendant children), stop and require Warp.
  - **Acceptance**:
    - Test matrix above passes; child provably still running on every non-confirm path.
    - Commit: `feat(pi): confirm child cancellation with q instead of double escape`.

- [ ] 5. Add a bounded, authoritative telemetry model (provider, model, tokens, context)
  - **What**: Project parser-approved `usage` events and existing model metadata into typed, bounded per-child telemetry on `ChildOverlayView`, with every field optional and absent when not authoritatively known.
  - **Files**: `packages/adapters/pi/src/child-session-events.ts` (typed narrow of the `usage` payload), `child-overlay-types.ts` (bounds + `ChildOverlayTelemetry` on the view), `child-overlay-controller.ts` (retain latest usage per child in saved state), `child-overlay-replay.ts` or the reducer wiring that feeds live events (route `usage` events to the controller), `__tests__/child-overlay.test.ts` (or a new `__tests__/child-overlay-telemetry.test.ts`).
  - **Depends on**: None (parallel with Tasks 2–4; merges before Task 6).
  - **Implementation outline**:
    1. Verify against Pi 0.83's actual `usage` payload shape (read `@earendil-works/pi-coding-agent` types in the installed package) which fields exist: input/output/cache tokens, total, and context-window or context-used figures. Only fields Pi actually reports are eligible; document the mapping in code comments.
    2. Define a Zod schema with pinned numeric bounds (non-negative integers, sane ceilings) parsing the bounded-JSON `usage` payload; parse failures or over-bound values yield `undefined` fields (typed, never thrown).
    3. Controller: store only the latest parsed telemetry per child in saved state (fixed-size, replaces prior — no history). Derive provider from the qualified model identifier only when the separator is unambiguous (`provider/model`); otherwise leave provider absent.
    4. Compute context percentage only when both context-used and context-limit come from the host; never estimate the limit from the model name.
    5. Expose `view().telemetry` with all-optional fields; historical children get telemetry only if replayed `usage` events exist in the loaded window.
  - **Pitfalls / non-goals**:
    - `usage.usage` is `boundedJson.optional()` — the event may carry nothing; that is a legitimate "unavailable" state, not an error.
    - Do not persist telemetry to the metadata cache in this plan (schema change ripple); in-memory bounded state only. Note as future work in the spec if desired.
    - No cross-run summation: show the latest report, clearly scoped to the active run.
  - **Acceptance**:
    - Tests cover: valid payload → populated fields; missing/oversized/malformed payload → absent fields, typed non-throwing path; latest-wins replacement; per-child isolation.
    - Commit: `feat(pi): project bounded child usage telemetry into the overlay view`.

- [ ] 6. Render telemetry in the overlay header with honest unavailable states
  - **What**: Add a header meta line showing provider, model, context %, and tokens, rendering `—` for any absent field, truncation-safe at all widths.
  - **Files**: `packages/adapters/pi/src/child-overlay-component.ts` (header layout), `__tests__/child-overlay-render-width.test.ts`, `__tests__/child-overlay-mount.test.ts`.
  - **Depends on**: Task 5.
  - **Implementation outline**:
    1. Compose one line, e.g. `provider · model · ctx 42% · 12.3k in / 4.1k out`, via the existing `fitLineWithSuffix`-style truncation; absent fields render `—` (or omit segment) — pick one convention and pin it in tests.
    2. Account for the extra header row in the transcript row budget so `overlayUsableRows` short-terminal guarantees still hold (editor and bottom border never clipped).
    3. Snapshot/width tests at narrow (e.g., 40 cols) and short-terminal heights; verify no panic and no editor clipping.
  - **Pitfalls / non-goals**:
    - Never invent values; a missing context limit means no percentage, not `0%`.
    - Keep the true-overlay options object byte-identical; geometry changes are out of scope.
    - Large token counts must be formatted within the bounded label length.
  - **Acceptance**:
    - Width/height tests pass including a fully-unavailable telemetry case; transcript budget math tested at the shortest supported terminal.
    - Commit: `feat(pi): show provider, model, context, and token info in the child overlay`.

- [ ] 7. Add a compact child-view mode with a clear toggle
  - **What**: A per-child compact mode that condenses transcript entries (collapsed tool calls/results, single-line previews) while keeping the header, telemetry, search, scroll model, and draft editor fully functional; toggled by a non-printable chord with an explicit header badge.
  - **Files**: `packages/adapters/pi/src/child-overlay-types.ts` (per-child `viewMode` in saved state + bounds), `child-overlay-controller.ts` (toggle handling + view field), `child-overlay-component.ts` (compact entry rendering + header badge + help line), optionally reuse reduction helpers from `child-compact-render.ts` without importing UI types into it; tests in `__tests__/child-overlay.test.ts`, `__tests__/child-overlay-render-width.test.ts`, `__tests__/child-overlay-keys.test.ts` if routed via the machine.
  - **Depends on**: Tasks 2 and 6.
  - **Implementation outline**:
    1. Choose the toggle key: prefer `ctrl+o` routed like `ctrl+e` (global expansion) through `isControllerInput` → `controller.handleInput`; verify no conflict via the existing conflict-port check pattern and document the choice. Never a bare printable key.
    2. Controller: `viewMode: "full" | "compact"` per child in saved state, default `full`, preserved while the overlay stays open, reset rules pinned by test (decide: persists across focus switches within a generation; resets on controller teardown).
    3. Component: in compact mode render bounded one-line entry summaries (reuse `truncateLatestOutput`/preview helpers), keep run dividers, keep the scroll model working against compact rendered rows (extent re-measured after toggle; `restoreScrollAnchor` keeps the viewport anchored).
    4. Header badge (e.g. `· compact`) and help line documenting the toggle; both truncation-safe.
    5. Tests: toggle round-trip, scroll extent re-measurement after toggle, draft preserved across toggle, search still matches loaded window, per-child mode isolation.
  - **Pitfalls / non-goals**:
    - Toggling changes rendered-row extents drastically; without anchor restoration the viewport jumps — pin anchor behavior with a test.
    - Do not fork the entry model; compact is a render-time projection, not a second transcript state.
    - Do not modify `child-compact-render.ts`'s parent-transcript contract (§6) — if code is shared, extract pure helpers instead of importing UI concerns into it.
  - **Acceptance**:
    - All listed tests pass; full↔compact toggle preserves draft, search state, and a stable anchor; bounds pinned.
    - Commit: `feat(pi): add compact child overlay view mode`.

- [ ] 8. Update spec, docs, and smoke checklist
  - **What**: Make the docs corpus reflect the new contract: Escape exit, `q` confirm-cancel, telemetry header, compact mode, and the scroll fix.
  - **Files**: `docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md` (§7 overlay behavior: scroll frame coverage per Task 1 findings, Escape/`q` semantics, telemetry line with unavailable-state rule, compact mode; §8 key table; §14 any new stable diagnostic codes; §17 supersede the double-escape rule), `docs/specs/33-spec-pi-adapter/33-smoke-checklist.md` (new steps: live scroll, Escape exit, `q` cancel both branches, telemetry visible/unavailable, compact toggle), `docs/specs/33-spec-pi-adapter/33-proofs/33-task20-e-double-escape-cancel-proof.md` (superseded banner pointing at the new proof), `docs/adapters/pi.md` (user-facing key/feature summary).
  - **Depends on**: Tasks 2–7.
  - **Implementation outline**:
    1. Rewrite §7's cancellation/exit paragraphs; add the telemetry and compact-mode requirements with their honest-unavailable and bounded-state rules.
    2. Update the smoke checklist with exact keys and expected observations for each new behavior.
    3. Run `bun run docs:check-links`.
  - **Pitfalls / non-goals**:
    - Do not delete historical proofs; supersede them (repo convention).
    - Keep spec language normative ("must"), matching what the tests pin.
  - **Acceptance**:
    - `bun run docs:check-links` passes; §7/§8/§17 consistent with implemented behavior; smoke checklist executable as written.
    - Commit: `docs(pi): update overlay spec, smoke checklist, and key docs for UX changes`.

- [ ] 9. Full gates, real Pi 0.83 live proofs, and reviews
  - **What**: Run all repo gates, execute the smoke checklist against real Pi 0.83 through the local symlinked adapter, write proof docs, and obtain Weft review (Warp only if Task 4 tripped the trust-boundary condition).
  - **Depends on**: Tasks 1–8.
  - **Implementation outline**:
    1. Gates: `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`, `bun run docs:check-links` — all green.
    2. Rebuild the local adapter (global symlink `~/.pi/agent/extensions/weave-adapter-pi`), restart Pi sessions, and run the updated smoke checklist in a fresh Pi 0.83 TUI on a real PTY: scroll all six keys live (and in the pi-vim coexistence scenario), Escape exit leaves child running (`weave runtime status` shows the lease intact until settlement), `q` confirm cancels and `q` dismiss does not, telemetry populated on a live child and honestly unavailable on a child with no usage events, compact toggle round-trip on live and historical children.
    3. Record proofs under `docs/specs/33-spec-pi-adapter/33-proofs/` (one doc, e.g. `33-overlay-ux-live-proof.md`, referencing the Task 1 diagnosis doc), per `docs/testing/adapter-verification.md`.
    4. Request Weft review of the full change set. Evaluate the Warp trigger: required only if cancellation authority or a trust boundary changed in Task 4; record the decision either way in the proof doc.
    5. Confirm no leaked child process and no active Runtime Store lease after the session.
  - **Pitfalls / non-goals**:
    - Existing Pi sessions must restart to load the rebuilt adapter — verify the loaded `dist/extension.js` hash before trusting the proof.
    - Health-only fail-closed behavior on Pi 0.83 (`descriptor-relative-native-session-io`) is expected in some configurations; the harness setup doc covers the environment that reaches ready.
  - **Acceptance**:
    - All gates green; live proof doc records every smoke item with observed evidence; Weft approval recorded; Warp decision recorded.
    - Commit: `docs(pi): record child-overlay ux live verification proof` (plus any `chore`/`fix` follow-ups Weft requires, each as its own conventional commit).

## Verification
Final confirmation, in order:

```bash
bun test                      # all packages green, incl. new overlay regression + telemetry + compact suites
bun run typecheck             # tsc --noEmit clean
bun run lint                  # biome + declaration validation clean
bun run build                 # public packages + docs site build
bun run docs:check-links      # docs links clean
```

Then the live pass: fresh Pi 0.83 TUI via the local symlinked adapter on a real PTY — all six scroll keys move the mounted overlay viewport (legacy and Kitty encodings, pi-vim scenario included); Escape returns to the parent with the child still running; `q` → confirm cancels the child, `q` → keep-running leaves it alive; header shows provider/model/ctx%/tokens on a reporting child and `—` states otherwise; compact toggle preserves draft, search, and scroll anchor. Proof docs committed under `33-proofs/`, Weft approved, Warp decision recorded, no residual child process or Runtime Store lease.

Commit guidance: one focused conventional commit per task as listed (`fix(pi)`, `feat(pi)`, `docs(pi)`); reference the originating issue in each commit footer and in the PR.
