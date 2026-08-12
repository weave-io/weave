# Pi Child Overlay UX Feedback: Overlay Controls, Pi Path Sessions, and Error Visibility

## TL;DR
Fix live overlay scrolling with a root-cause diagnosis and regression proof, change Escape to exit inspection without cancelling, move child cancellation behind an explicit `q` confirmation, add authoritative usage telemetry and a compact child-view toggle, conform child persistence to Pi 0.84.1's real path-based `SessionManager` API with adapter-owned containment guarantees, and replace generic child failures with bounded, sanitized provider error details.

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
  - Pi 0.84.1 path-based native child sessions behind an adapter-owned contained-path boundary; Pi remains the session-format authority and the engine never receives a path.
  - Bounded, sanitized child provider/transport errors in full, compact, historical, and fallback rendering.
- Out of scope:
  - Mouse-wheel scrolling (Pi does not enable mouse reporting; explicitly out of contract per §7).
  - Custom-editor fallback inspection parity for the new features beyond not regressing it.
  - Engine/core changes; any new delegation authority. Cancellation reuses the existing `delegationController.cancelSubtree` path.
  - Estimating tokens or context size when the host does not report them — no guessing.
  - Provider model changes, retry policy changes, or hiding rate limits by switching models. The observed Anthropic 429 failures are separate from the Pi session capability blocker.
  - An unsafe capability override, caller-supplied arbitrary paths, or a second transcript format.
- Constraints / assumptions:
  - Preserve pi-vim and primary-editor ownership: never touch `setEditorComponent`; `ui.custom` owns input while mounted; the terminal-input route stays conflict-checked and never steals host/user keys.
  - Typed `neverthrow` failures on every expected-failure path; no `console.*`; no throws.
  - All new state bounded with pinned constants; true-overlay geometry (`overlay:true` options) and `overlayUsableRows` short-terminal guarantees unchanged; settlement/generation guards (`activeGenerationId`, `childOverlayCell.generationId`, settle-once) unchanged.
  - Bun-only tests (`bun test`), mocks for the harness boundary, real-harness proof per `docs/testing/adapter-verification.md`.
  - Warp review is mandatory for the path-session work and child-error sanitization because they change filesystem and untrusted-input boundaries. Review must use the repository threat model: adapter/Pi code and processes running as the Weave user are trusted; malicious same-user races are residual risk and do not justify an API Pi does not provide. Reusing the existing confirm→`cancelSubtree` authority still adds no cancellation trust surface.
  - The dirty checkout contains pre-existing, unreviewed changes in the same session files plus concurrent work in `rpc-child.ts` and `child-session-events.ts`. Every new task must preserve unrelated bytes, identify ownership before staging, and use exact-hunk staging or an isolated clean worktree.

## Objectives
- Scrolling works in the real mounted overlay under Pi 0.83 on a real PTY, with a written diagnosis, a regression test that fails on the old code, and a live proof.
- Escape = exit inspection, never cancel. `q` + explicit confirmation = cancel. No hidden destructive path remains.
- The overlay header shows provider, model, context %, and tokens when authoritative data exists, and honest placeholders when it does not.
- A compact view mode toggles clearly, preserves scroll/draft behavior, and stays within bounds.
- Delegation reaches ready on real Pi 0.84.1 by proving an adapter-owned contained-path invariant around Pi's native path API, without claiming Pi exposes descriptor-relative I/O.
- Child failures identify useful bounded facts such as provider source, failure class, HTTP status, safe code, and a short sanitized message instead of only `assistant stop reason: error`.

## Dependencies and Order
1. Task 1 (diagnosis) must land first: the scroll fix (Task 2) must implement the proven root cause, not a guess.
2. Task 3 (Escape exit) precedes Task 4 (`q` cancel): Task 4 reuses the confirm machinery that Task 3 detaches from Escape, so sequencing avoids an intermediate state with no cancel path.
3. Task 5 (telemetry data model) precedes Task 6 (header rendering): rendering consumes the typed view fields Task 5 adds.
4. Task 7 (compact mode) depends on Task 2 (scroll must be correct before adding a second layout that shares the scroll model) and on Task 6 (header/help lines it must coexist with).
5. Task 8 (the original overlay docs/spec/smoke update) depends on Tasks 2–7.
6. Task 9 audits real Pi subagent implementations, reconciles the dirty path-session changes, and replaces the fictional descriptor requirement with a Pi-native path contract. Task 10 writes conformance and containment RED tests for the stated local-user trust model. Task 11 implements the Pi-native contract and cannot merge until Warp approves it against that model.
7. Task 12 adds the sanitized error model and parser. It can begin after ownership of `child-session-events.ts` is handed off, but Task 13 rendering depends on it.
8. Task 14 updates all affected docs and runs reviews, clean gates, real Pi 0.84.1 delegation/error/overlay proofs, and cleanup. It depends on Tasks 11 and 13 and completes the original live-proof objective.

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

- [x] 4. Gate child cancellation behind `q` with explicit confirmation
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

- [x] 5. Add a bounded, authoritative telemetry model (provider, model, tokens, context)
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

- [x] 6. Render telemetry in the overlay header with honest unavailable states
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

- [x] 7. Add a compact child-view mode with a clear toggle
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

- [x] 8. Update spec, docs, and smoke checklist
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

- [x] 9. Audit real Pi subagent libraries and define the Pi-native session contract
  - **What**: Replace the blocked descriptor design with the path-based contract Pi and real Pi subagent extensions use. Reconcile the dirty checkout without adopting unknown code blindly.
  - **Files**: official Pi 0.84.1 `examples/extensions/subagent/`, `docs/session-format.md`, `docs/extensions.md`; reference snapshots `mjakl/pi-subagent@70248dcf`, `nicobailon/pi-subagents@c386b258`, `baochunli/pi-collaborating-agents@acd50d0`, `hazat/pi-interactive-subagents@c100577`; read/audit `packages/adapters/pi/src/native-session-host.ts`, `child-native-sessions.ts`, `child-session-storage-authority.ts`, `extension.ts`, related tests; rewrite `docs/specs/33-spec-pi-adapter/33-path-session-conformance-design.md`; plan checkbox.
  - **Depends on**: Task 8.
  - **Implementation outline**:
    1. Add a behavior-level parity matrix for spawn mode, `--session`/`--session-dir`/`--no-session`, SessionManager use, persistence/resume/fork, path ownership, cancellation, and error propagation. The official example is the normative ephemeral reference; third-party code is evidence, not authority.
    2. Pin the Pi-native persistent-child design: call `SessionManager.create` for Pi's generated path, v3 header, session ID, parent, and `cwd`; because Pi defers the first write, exclusively create the validated immediate-child 0600 leaf with that exact Pi-generated header, reopen it through `SessionManager.open`, and revalidate every identity field. This bridge persists Pi's identity; it must not fabricate a v3/fork header. Start the child in RPC mode with both `--session <validated-file>` and `--session-dir <validated-child-directory>`; scrub any conflicting inherited `PI_CODING_AGENT_SESSION_DIR`, and require the explicit CLI directory to override Pi settings. Assistant semantic terminal state is authoritative, stderr and exit status are secondary; Pi v3 JSONL remains the sole transcript.
    3. Remove `descriptor-relative-native-session-io` and any replacement public contained-path capability from the design. External readiness remains `delegated-specialist-execution`; it is available when Pi's real session/process APIs and the adapter-owned session root initialize successfully. Readiness failures use only `pi-session-api-unavailable`, `pi-session-root-unavailable`, `pi-session-root-unsafe`, or `pi-process-unavailable`; raw host messages and paths are prohibited.
    4. Pin the existing repository threat model: model, prompt, project data, and other OS users are untrusted; Pi, adapter code, and processes running as the Weave user are trusted. Malicious same-user path races are residual risk and out of scope. Do not require descriptor-relative, lifetime-held descriptors, prefix-digest append proofs, or tombstone protocols that Pi itself does not provide.
    5. Keep practical containment: trusted XDG-derived fixed root, adapter-generated bounded component/basename, canonical immediate-child equality (never prefix-only), private 0700 directories, regular 0600 files, no caller/model path, Pi-returned path/header/parent/cwd/session-id/persistence validation, typed host failures, and no path exposure to engine/model/log/lifecycle data. `cwd` defaults to the canonical parent workspace cwd; a narrower cwd is allowed only from trusted adapter/operator policy, must match exactly after create/open, and is not a filesystem sandbox.
    6. Diff dirty files against `6035fe8`/`d59edf0`; identify unknown gate-removal hunks, concurrent owners, and which behavior must be reconstructed and tested independently.
    7. Obtain Warp review against this explicit threat model. Warp may block actual containment or disclosure defects; it must not reintroduce an unavailable opaque-descriptor requirement for an out-of-scope same-user attacker.
  - **Acceptance**:
    - The design cites exact reference code, records adopt/reject/different-by-design decisions, removes the fictional host capability, defines exact Task 10 RED tests, and has Warp approval. No production/test source is committed.
    - Commit: `docs(pi): define the Pi-native child session contract`.

- [x] 10. Add RED tests for the Pi-native session contract
  - **What**: Write baseline-failing tests for the actual Pi path/session/process contract and the adapter's stated containment boundary.
  - **Files**: `packages/adapters/pi/src/__tests__/native-session-host.test.ts`, `child-native-sessions.test.ts`, `child-session-storage-authority.test.ts`, `extension.test.ts`, RPC/direct-dispatch argument tests, and capability/probe tests that currently require the descriptor ID.
  - **Depends on**: Task 9.
  - **Implementation outline**:
    1. Prove a valid `SessionManager.create` result supplies the path/header/session ID/parent/cwd, the absent immediate-child leaf is exclusively created at 0600 with the exact Pi-generated header plus newline, `SessionManager.open` returns the same identity, and the spawned Pi child receives both `--session <that path>` and `--session-dir <the validated child directory>` in RPC mode with `shell:false` and bounded stdio handling. Pin that conflicting `PI_CODING_AGENT_SESSION_DIR` is removed and settings/environment cannot redirect the opened session directory.
    2. Prove callers/models cannot supply paths. Reject traversal, absolute refs, wrong root, symlinked returned paths, wrong kind/mode, root escape, existing-leaf collision, altered/fabricated header, wrong parent/cwd/session-id, non-persisted reopened handles, and create/open/getter throws. Assert zero later Pi/process effects when validation can reject first. Pin canonical parent-workspace cwd, trusted narrower-policy cwd, and exact post-open equality.
    3. Assert 0700 root/child directories and 0600 regular session files, exact immediate-child containment, and no path in Results, health/status/doctor/CLI output, logs, Runtime Store/lifecycle metadata, model/tool content, or proof fixtures.
    4. Assert the obsolete descriptor capability and unconditional storage-authority rejection are absent. `delegated-specialist-execution` becomes ready only when the real Pi API/root/process probes pass and otherwise remains health-only before spawn. Pin the four closed path-free readiness reasons and assert raw host text, causes, and paths never appear.
    5. Pin Pi-native semantic completion: assistant `stopReason`/`errorMessage` first, stderr second, exit/signal last; process-group abort and cleanup remain bounded.
    6. Demonstrate the intended RED state against committed production code and record exact failures. Do not add tests for malicious same-user races that the threat model excludes.
  - **Acceptance**:
    - Each test fails for one missing contract behavior without relying on unknown dirty source hunks. Commit: `test(pi): define the Pi-native child session contract`.

- [x] 11. Implement Pi-native path sessions and remove the descriptor gate
  - **What**: Conform delegation to Pi 0.84.1's real path/session/process APIs and delete the fictional descriptor requirement.
  - **Files**: `packages/adapters/pi/src/native-session-host.ts`, `child-native-sessions.ts`, `child-session-storage-authority.ts` (remove or reduce to real API/root readiness), `host-compatibility-matrix.ts`, capability declarations/prober, `extension.ts`, RPC/direct-dispatch/session-ref wiring, exports, and Task 10 tests.
  - **Depends on**: Task 10.
  - **Implementation outline**:
    1. Reconstruct the change from the committed baseline and approved design; do not wholesale-stage unknown dirty gate-removal hunks.
    2. Adapt `SessionManager.create/open` and every accessed handle method through `Result`/`ResultAsync`. Validate Pi's generated immediate-child path and identity facts; exclusively persist its exact deferred v3 header at 0600; reopen and revalidate path/header/session ID/parent/canonical cwd/persistence; then pass that validated file and directory to child Pi with explicit `--session` plus `--session-dir` in the existing RPC launch. Remove conflicting inherited `PI_CODING_AGENT_SESSION_DIR` and prove Pi settings cannot redirect the validated directory.
    3. Remove `requireDescriptorSafeSessionIo`, `descriptor-relative-native-session-io`, `path-only-session-api` as a blanket failure, and any public replacement capability. Keep a narrow internal readiness check for the real Pi methods, root creation/permissions, and process launch. Map failures only to the four closed path-free readiness reasons; keep raw exceptions private.
    4. Preserve native Pi v3 JSONL, persistence/resume/reopen/thread lineage, generation/settlement guards, bounded process cleanup, and semantic error precedence. Do not add a parallel transcript, custom lock authority, or mux-specific behavior.
    5. Ensure engine/model/operator-facing data is path-free. Keep all concrete path construction and validation in the Pi adapter.
    6. Run focused tests, full Pi tests, typecheck, and lint. Obtain mandatory Warp review against the Task 9 threat model and Weft review. Resolve every real containment/disclosure or correctness blocker before completion.
  - **Acceptance**:
    - Task 10 is green; real Pi 0.84.1 reaches ready and creates, streams, settles, resumes, and reopens a native child session without unsafe flags or fictional capabilities; no path crosses the adapter boundary; Warp and Weft approve.
    - Commit: `fix(pi): use Pi-native path sessions for child delegation`.

- [x] 12. Project bounded, sanitized child provider errors
  - **What**: Parse Pi 0.84.1 assistant terminal errors into a closed, bounded child-error model without retaining raw provider payloads.
  - **Files**: coordinate handoff before touching `packages/adapters/pi/src/child-session-events.ts`; prefer a new `child-provider-error.ts`; update `child-overlay-types.ts`, replay/controller wiring, exports, and new `__tests__/child-provider-error.test.ts` plus parser/replay tests.
  - **Depends on**: Task 8; may run after Task 9 once the concurrent parser owner hands off.
  - **Implementation outline**:
    1. Define Zod-bounded optional fields: source, class (`rate-limit`, `auth`, `timeout`, `overload`, `connection`, `cancelled`, `malformed-response`, `provider-error`, `unknown`), HTTP status, allowlisted safe code, and short sanitized message.
    2. Parse only Pi's actual `stopReason:"error"` and bounded `errorMessage`. Derive class/status/code only from unambiguous evidence; never invent a provider fact.
    3. Strip request IDs, URLs, headers, tokens/secrets, filesystem paths, prompt/completion text, nested JSON, control characters, and oversized content. Convert unsafe or malformed input to honest generic copy.
    4. Retain at most the latest terminal error for the run/entry; isolate children; replay historical Pi events through the same sanitizer. Raw payloads must not enter Runtime Store, engine APIs, Weave logs, or lifecycle metadata. Pi's own native session remains Pi-owned input.
    5. Tests: sanitized 429, 500/no body, auth, timeout, overload, connection, cancellation, malformed response, malicious secret/path/URL/request-id payloads, oversized/malformed values, latest-wins, replay, and child isolation.
  - **Acceptance**:
    - Tests prove useful safe fields survive and prohibited data never does; all expected failures use `Result`/`ResultAsync`. Commit: `feat(pi): project sanitized child provider errors`.

- [x] 13. Render useful child errors in every inspection surface
  - **What**: Replace generic `assistant stop reason: error` output with the sanitized projection in full, compact, historical, and fallback child views.
  - **Files**: `packages/adapters/pi/src/child-transcript.ts`, `child-overlay-replay.ts`, `child-overlay-component.ts`, compact/fallback renderer(s) that emit the generic string, focused render-width/mount/history tests, and parent-summary tests where applicable.
  - **Depends on**: Task 12.
  - **Implementation outline**:
    1. Render a consistent bounded line such as `assistant error · rate limit · HTTP 429 · provider rate limit exceeded`; omit unavailable segments and use `assistant error · details unavailable` rather than raw input.
    2. Preserve the same sanitized facts through live updates, settlement, compact toggles, historical replay, and custom-editor fallback. Never leak one child's error into another child or the parent transcript outside its bounded child summary.
    3. Keep lines width-safe on narrow terminals and preserve overlay row budgeting, scroll anchors, search, draft, and live-tail semantics.
    4. Tests must assert useful rendering and explicit non-presence of request IDs, URLs, paths, bearer/token-like strings, arbitrary JSON, control characters, and oversized tails.
  - **Acceptance**:
    - Full/compact/historical/fallback tests show actionable safe details for 429/500/connection/timeout and honest generic copy otherwise; full Pi tests and typecheck pass.
    - Commit: `feat(pi): show sanitized provider errors in child views`.

- [ ] 14. Update contracts, run gates, and prove real Pi behavior
  - **What**: Update all affected contracts, run clean gates, prove native delegation plus overlay/error UX on real Pi 0.84.1, and complete the original live-proof objective.
  - **Files**: `docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md`, `33-smoke-checklist.md`, `33-path-session-conformance-design.md`, `33-proofs/33-overlay-ux-live-proof.md`, historical fail-closed proofs/acceptance manifest as superseded references, `docs/adapters/pi.md`, capability/ADR docs, and both plan checkboxes.
  - **Depends on**: Tasks 11 and 13.
  - **Implementation outline**:
    1. Document the Pi-native path/session contract, reference parity matrix, threat model, typed failures, sanitized error schema/rendering, and removal of the old descriptor-only health claim. Preserve historical proofs with banners; do not rewrite history.
    2. From an exact clean subject run `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`, and `bun run docs:check-links`.
    3. Build an exact artifact and launch isolated real Pi 0.84.1 with pi-vim. Verify ready state, native child create/reopen/settlement/history, no path exposure, all six overlay scroll keys, Escape child-still-running, q dismiss/confirm/non-empty draft, telemetry available/unavailable, compact live/historical round-trip, and cleanup.
    4. Trigger safe real/simulated provider failures through the real harness boundary and observe sanitized 429, 500/no-body, connection/timeout, and unavailable-detail rendering without forbidden data. Do not deliberately expose credentials or depend on an active provider outage.
    5. Record exact subject, artifact/dist hashes, commands, observed evidence, owner-approved Pi 0.84.1 target, cleanup, Weft approval, and mandatory Warp approval in `33-overlay-ux-live-proof.md`.
    6. Confirm no leaked child process and no active Runtime Store lease; close only the created pane. Mark Task 14 and the original live-proof objective complete only after every item is observed.
  - **Acceptance**:
    - All gates green; Pi 0.84.1 delegation is ready without unsafe flags; proof records every overlay and error-visibility item; Warp and Weft approve; cleanup is empty.
    - Commit: `docs(pi): record path-session and child-error live proof`.

## Verification
Final confirmation, in order:

```bash
bun test
bun run typecheck
bun run lint
bun run build
bun run docs:check-links
```

Then run an exact-subject real Pi 0.84.1 pass: `delegated-specialist-execution` is ready through Pi's native path/session contract with no descriptor capability; a native child can create, stream, settle, resume, reopen, and render history; all overlay controls and telemetry pass; full/compact/historical/fallback views show bounded sanitized provider errors instead of generic stop text; no forbidden data appears; Warp and Weft approve; no child process or Runtime Store lease remains.

Commit guidance: one focused Conventional Commit per task (`test`, `fix`, `feat`, `docs`); preserve unrelated dirty work and reference the originating issue when known.
