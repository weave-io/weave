# 33 — Weave UI design record: delegation card and child inspector

Status: active. Owner: Pi adapter.
Implementation issue: [#21](https://github.com/weave-io/weave/issues/21).

This record fixes the vocabulary, geometry, drop order, and honesty rules of the
two Weave surfaces inside Pi. It is UI only. It restates no storage, RPC, or
delegation semantics; those live in
[Spec 33](33-spec-pi-adapter.md).

Two committed prototypes are the normative reference. Every decision below names
the prototype symbol or constant that enforces it, so a reviewer can check an
implementation against a specific piece of code rather than against prose:

| Reference | File |
| --- | --- |
| Delegation card | `prototypes/weave-delegate-tool-grilling.ts` |
| Child inspector and Plan Rail | `prototypes/weave-pi-tui-grilling.ts` |

The prototypes are outside `tsconfig.json` `include` and `biome.json`
`files.includes`. They never enter typecheck or lint, and they ship no code.
Their demo scaffolding — `DemoStore`, `StreamController`, the `/grilling`
commands, `pi.appendEntry`, `pi.registerEntryRenderer`, mock data, and every
`DEMO DATA` mark — is explicitly not part of this contract.

## 1. Delegation card

Reference: `prototypes/weave-delegate-tool-grilling.ts`.

| # | Locked decision | Prototype anchor |
| --- | --- | --- |
| 1.1 | One framed card per run: exactly one top edge and one bottom edge, and no corner glyph inside the card. | `renderCard`, `cardEdge`, `cardBody`, `MIN_CARD_WIDTH` |
| 1.2 | Collapsed height is four to six rows at every width, and does not change at settlement. | `renderCard`, `cardBody` |
| 1.3 | Status-first left rail, ten columns: toned bar plus upper-case state word, then the child agent name, then elapsed. | `railStatusFirst`, `RAIL_W = 10`, `RAIL_DIVIDER_W = 3` |
| 1.4 | The rail's drop order is mechanical: state and child name always survive; elapsed is the only droppable cell, and below the minimum body width identity folds and the rail disappears. | `railPlan`, `RAIL_MIN_BODY = 17`, `RAIL_TIGHT_SLACK = 16`, `RAIL_CELL_MAX = 3` |
| 1.5 | The top body row is one imperative assignment sentence in the parent's own words: no provenance prefix, acceptance clause, scope field, or routing rationale. | `assignmentRows`, `fitTask` |
| 1.6 | Beneath the assignment there is exactly one Native Line: a semantic glyph plus the single most meaningful thing the child has produced. | `nativeLine`, `ACTIVITY_GLYPH`, `liveActivity` |
| 1.7 | Balanced edge footer: telemetry left, actions right, one bottom edge. | `cardFooter`, `composeEdge` |
| 1.8 | The action side is measured first, so an affordance always outlives a number, and telemetry never outlives `Ctrl+O`. `Alt+I` is the last hint standing. | `composeEdge`, `actionLadder`, `INSPECT_HINT_MIN` |
| 1.9 | The footer's left ladder prints the run and the lifecycle phase, never the status word the rail owns. | `runDescriptor`, `teleLadderFull`, `runParts` |
| 1.10 | `Ctrl+O expand · Alt+I inspect child` are the only actions the card ever prints. It never offers retry, steer, resume, or cancel, in any state. | `actionLadder` |
| 1.11 | The expand verb is `expand` while running and `details` once settled. | `expandHint` |
| 1.12 | Expanded, the card adds one interior rule and a fixed-height child viewport: one status strip (`LIVE · following bottom` / `AT BOTTOM · child settled`, plus `↑ N rows above`) over exactly nine literal bottom transcript rows, nothing summarized, grouped, or relabelled. | `detailRegion`, `childViewport`, `VIEWPORT_ROWS = 9`, `DETAIL_ROW_MIN`, `DETAIL_ROW_MAX`, `aliveness` |
| 1.13 | Native settlement: the settlement rewrites the rail word, the Native Line, and the footer verb, and adds no row, banner, border verdict, or action deck. | `settledRow`, `terminalFacts` |
| 1.14 | The settlement is the only completion authority: terminal facts exist only when an authoritative settlement named a row with text, so an ended-but-unsettled assistant message can never claim completion. | `activeTerminal`, `authoritativeText` |
| 1.15 | A failed card prints the already-redacted reason, and names recovery only where the failure class is documented as recoverable. | `retryGuidance`, `TERMINAL_BODY_MAX` |
| 1.16 | A cancelled card names the initiator in safe terms, says the partial work was kept and nothing was verified, and never claims success. | `terminalFacts` (cancelled tail) |
| 1.17 | Every child-sourced string is sanitized before it becomes a segment, and box-drawing glyphs are reachable only through the frame primitive, so child text structurally cannot forge a frame. | `safeText`, `glyph` |
| 1.18 | Exactly one function turns rows into terminal output, and it clips to the viewport width. | `emit` |
| 1.19 | The vocabulary is production's: every state transition names one parser-approved event from `child-session-events.ts`, plus the overlay replay `input` step and the authoritative settlement. | prototype header, section 5g "THE SHARED STREAM" |

## 2. Child inspector overlay

Reference: `prototypes/weave-pi-tui-grilling.ts`.

| # | Locked decision | Prototype anchor |
| --- | --- | --- |
| 2.1 | Exactly one high-contrast titled outer frame wraps the overlay and carries the live state marker. No fake transcript, editor, or footer is drawn outside it. | `frameOverlay`, `frameTop`, `FRAME_TITLE`, `FRAME_COLUMNS` |
| 2.2 | Session header row 1: inverse ` CHILD ` badge · agent name · model · role · bounded task title, all left-aligned. The model sits immediately after the name and appears exactly once. | `composeSessionHeader`, `headerIdentityRow`, `HEADER_FACT_ORDER` |
| 2.3 | Session header row 2: `delegated by <PARENT>` · plan › task › subtask, shedding subtask first, then plan. | `headerContextRow` |
| 2.4 | The header carries no telemetry row and no child ID, structurally: its fact type has no field for either. | `HeaderFacts` |
| 2.5 | Layout is Pi-native transcript left, Status Matrix rail right, prompt group below. | `renderPiNative`, `splitRail`, `joinColumns`, `RAIL_GEOMETRY = {min:30,max:42,ratio:0.34}`, `TRANSCRIPT_MIN` |
| 2.6 | The transcript is Pi-native: role gutters, understated read / edit / bash calls and results, reasoning as a summary only, and plain streaming and final assistant responses. Raw chain-of-thought is never rendered. | `renderPiNative` |
| 2.7 | The rail is an aligned key/value matrix grouped lifecycle · work · spend, with an inverse alert pair above the matrix when a tool fails. | `renderRailStatusMatrix`, `MATRIX_KEY = 8`, `stackSections` |
| 2.8 | Below `RAIL_GEOMETRY.min + TRANSCRIPT_MIN + 1` the rail folds to its compact matrix form rather than disappearing. | `compactStatusMatrix` |
| 2.9 | The transcript window has a tail mode and an anchored mode, with explicit `↑ earlier` / `↓ later` rows. | `transcriptWindow` |
| 2.10 | The prompt is a primary-like editor: a bordered panel over one muted key row. | `renderPromptGroup`, `promptPrimaryEditor`, `promptField` |
| 2.11 | Field text and caret are resolved once from the facts, so a settled child structurally cannot be shown a live input or a caret. A cancelled child is settled exactly like a completed one. | `PromptFacts`, `promptFacts`, `settlementFacts` |
| 2.12 | A disabled key prints an explicit `✕`, not only dim colour, so a settled child reads as unactionable on a monochrome terminal. | `keyChip` |
| 2.13 | The key row sheds ordinary notes, then the danger note, then whole chips in ladder order: `/ search`, then `Alt+Enter queue`, then `q cancel`. `Enter` and `Esc` are the floor. | `keyLine`, `keyLadder` |
| 2.14 | The prompt group answers the cancel confirmation itself and never reaches the editor while it is open, so `q` can never cancel without a `y` / `n` answer. | `renderPromptGroup`, `promptCancelConfirm` |
| 2.15 | Rail search: `/` prepends a SEARCH section to the rail and the transcript grows a two-column marker gutter; `n` / `N` (aliases `j` / `k`) move and `Enter` jumps and latches the anchor. | `searchRailSections`, `markSearchGutter`, `SEARCH_INSET = 2` |
| 2.16 | The match list is built from an ANSI-free twin render, so no byte of transcript colour can paint the search rail, and prompt facts cannot reach nav facts, so the prompt is byte-identical with search open and closed. | `NavFacts`, `navFacts`, `navMatchList` |
| 2.17 | Key precedence, stated once: **cancel confirmation › search › overlay**. While the confirmation is open only `y`, `n`, and `Esc` are read; movement keys exist only while search is open; `Esc` closes search before it closes the overlay. | `InspectorOverlay.handleInput` (`prototypes/weave-pi-tui-grilling.ts:3369`) |
| 2.18 | Native settlement: no new chrome at all. The authoritative final response, the safe failure line, the cancellation record, and the retry record are ordinary transcript events; the frame marker and the rail carry the state word. There is no banner band, rail verdict section, transcript checkpoint block, or action deck. | prototype header item 9, `settlementFacts` |
| 2.19 | Failure text reaches the screen only through the sanitizer, which strips ANSI, removes stack frames, redacts credential-shaped tokens and long opaque IDs, and hides absolute paths. | `safeText` |
| 2.20 | The child ID appears in exactly one place: the transcript's bootstrap row. It is never a raw opaque ID and never a secret. | `CHILD.childId`, `BASE_EVENTS[0]` |

## 3. Shared width-safety rules

Both prototypes carry the same guarantee, and production hosts it in one shared
layer: one function turns rows into strings and clips them, measurement is
separate from colour, and untrusted text can only ever become a plain segment.
The anchors below name the file each primitive is defined in.

| # | Locked decision | Prototype anchor |
| --- | --- | --- |
| 3.1 | Segments and rows are measured, clipped, padded, and filled before emission; `emit` is the only function that turns rows into terminal output, and it clamps to the width. | `emit`, `rowWidth`, `clipRow`, `padRow`, `fitRow` (card prototype) |
| 3.2 | Box-drawing and block-element glyphs are reachable only through `glyph()`, which mock and child data cannot call. | `glyph` (both prototypes) |
| 3.3 | Pieces are joined in priority order and every piece that does not fit is dropped, except the first, which is clipped. | `joinFit` (inspector prototype) |
| 3.4 | Fallible layout arithmetic returns a `Result` and fails closed so callers degrade, rather than throwing. Column joining pads short columns instead of failing. | `splitRail`, `reserveRows`, `joinColumns`, `cell` (inspector prototype) |

## 4. Plan Rail widget

Reference: `prototypes/weave-pi-tui-grilling.ts`.

| # | Locked decision | Prototype anchor |
| --- | --- | --- |
| 4.1 | The Plan Rail is the single owner of ambient parent context. It mounts above the real Pi editor and survives `Esc`. | `renderPlanRailWidget` |
| 4.2 | Row 1: `◆ WEAVE · <AGENT>` · `Alt+A cycle` · plan name. Row 2: spaced task marks and the ordinal (`3/8`). Row 3: `┃ now` and the active task. Row 4: `┗ next` and the following task. | `renderPlanRailWidget`, `planDots` |
| 4.3 | It reads parent-side facts only, so it structurally cannot print a child ID, token count, cost, elapsed time, or queue depth, and it is byte-identical in every child state. | `WidgetFacts`, `widgetFacts` |
| 4.4 | It degrades through measured width bands, never guessed ones. | `widgetTier` (`wide` ≥ 96, `mid` ≥ 68, `tight` ≥ 46, `micro` below) |
| 4.5 | The cycle hint appears only when there is somewhere to cycle to, drops its descriptive word before its key, and is placed ahead of the plan name, so a narrowing terminal surrenders the plan before the key. | `cycleHint`, `joinFit` |
| 4.6 | The agent name is the last thing the widget may lose. | `joinFit`, `widgetBadge` |

## 5. Production mapping decisions

These decisions translate the prototypes into the Pi host. They are recorded
here because they are choices, not consequences.

| Decision | Reason |
| --- | --- |
| The card renders through the registered `weave_delegate` tool's `renderResult` with `renderShell: "self"`, not through `pi.appendEntry` plus a registered entry renderer. | The prototype only appends an entry because a demo has no real tool call. In production the tool call already exists, and `renderShell: "self"` puts the component in a bare container so Pi draws no second box or tint around the card's own frame. |
| The card's state is carried in the tool result's `details` as a versioned, bounded, strictly parsed view model. | `details` is persisted on the tool result message and never reaches the model, so a card re-rendered after restart or replay is a pure function of the last published payload, and `content[0].text` can stay a bounded model-visible activity line. |
| `Ctrl+O` is Pi's own `app.tools.expand`; Weave registers no binding for it. | The host already owns the action for tool results. Registering it would either conflict or duplicate. The card prints it as a hint only. |
| `Alt+I` is the existing Weave picker action, printed on the card and bound only where it already was. | The card must never introduce a keybinding, and the picker route already exists in §8.1. |
| Rail search opens on an empty-draft `/` rather than `Ctrl+F`. | `Ctrl+F` is Pi's own `tui.editor.cursorRight` alias, so the existing `Ctrl+F` search route is normally disabled by conflict detection and in-overlay search is effectively unreachable. `/` on an empty draft is free and matches the prototype. |
| The per-child `full` / `compact` overlay view mode is removed outright. | The finalized inspector has one view. A second render-time projection would fork the geometry this record fixes, and it freed `Ctrl+O` for the host's own expand action. |
| The cancel confirmation moves inside the overlay. | The prototype's prompt group answers `y` / `n` itself, which is what makes "`q` never cancels on its own" structural rather than remembered. |
| The Plan Rail becomes the single owner of ambient parent context, and the separate task footer is removed. | Two surfaces printing the same task is duplication, and the header's row 2 already carries the plan breadcrumb for the child's own context. |
| Telemetry lives only on the Status Matrix rail, and the overlay header loses its telemetry row. | Identity is stated once and in one place: model beside the child name, numbers on the rail, parent context above the editor. |
| The header's bounded slot carries the child's assignment, and a durable STORAGE title (`shuttle-1d33e680`) is dropped rather than printed. | The prototype's `boundedTitle` is a task title. Production's stored title is derived by `resolveDurableChildTitle` from the agent name plus an opaque id fragment, so printing it repeats the name the header already carries and puts a thread-like id in a semantic slot, against §2.4 and §2.20. An absent fact prints nothing, which is the same honesty rule the rail follows. |
| The live prompt renders Pi's own editor INSIDE the locked panel, with the editor's own top and bottom rules removed. | Pi's editor draws two bare horizontal rules and no side rails, so using it unwrapped turns §2.10's bordered, labelled panel into an unlabelled underline at the bottom of the overlay. The panel keeps the editor's caret, multi-line editing and app keybindings while the design keeps its geometry. Scroll edges (`─── ↑ 3 more ───`) carry words and survive, because they are content. |
| The composed body is budgeted against its CONTENT, between a floor and the rows available, rather than always filling the canvas. | The prototype fills a demo-sized surface. A real overlay is `86%` of a tall terminal, where a short transcript would be stretched into empty space and the prompt stranded at the bottom, detached from the hierarchy it belongs to. The floor keeps a usable reading window and stops the surface resizing on a child's first few events. |

## 6. Related contracts

- [Spec 33 — Pi child sessions](33-spec-pi-adapter.md)
- [Spec 33 smoke checklist](33-smoke-checklist.md)
- [Spec 33 threat model](33-threat-model.md)
- [Pi adapter](../../adapters/pi.md)
- [Adapter boundary](../../architecture/adapter-boundary.md)
</content>
