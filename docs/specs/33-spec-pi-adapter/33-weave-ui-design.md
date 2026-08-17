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
| 2.6a | Production mapping of §2.6: `child-overlay-pi-native.ts` renders every `PiChildTranscriptEntry` kind in that one style — `❯` prompt, `✻ reasoning` for raw chain-of-thought (content-free) and `✻ reasoning · SUMMARY` only for an explicit host `reasoning_summary`, `⚙ name(args)` with its `⎿` outcome, `● <child> · reply` with the streaming caret, `↯ queue n`, `· status`, `· usage`, and a full-width `── retry · attempt n ──` run divider. The per-event timestamp column has no authoritative production source and is absent rather than invented. | `renderOverlayPiNative`, `renderOverlayTranscript` |
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
| The composed body takes every row the header and the prompt did not reserve, exactly as `bodyRightRail` composes it. | The prototype's transcript window and Status Matrix both pad to the rows they were given, so the rail reads as one full column beside the transcript and the surface keeps a stable height across a child's first events. Budgeting the body against its content instead was tried and reverted: it shrank the rail mid-run and produced a surface the design record does not describe. |
| §2.6's transcript is `child-overlay-pi-native.ts`, a direct port of `renderPiNative` over `PiChildTranscriptEntry`. Pi's own native message components are NOT used for this pane. | Pi's components paint the HOST's transcript: they carry its shell-integration markers, follow its own width contract, and emit no queue, status, retry or tool-outcome row at all. Mounting them inside the inspector produced neither the prototype's design nor half of what the child was doing. The port keeps the glyph gutter, the `⎿` continuation, the reasoning SUMMARY and the streaming caret, and adds only the two things a real child forces: a per-family row budget, and `safeTrim` / `stripPathLike` on every untrusted value. |
| §2.7's rail projects LIFECYCLE and WORK from the transcript reducer, and falls back to the descriptor only for facts no event reported. | The descriptor is a snapshot taken when the reader opened the child and is refreshed exactly once, at settlement. Projecting the rail from it printed `—` for every WORK fact for the whole life of a run, and froze queue depth, turn and tokens at their open-time values. The reducer is fed by `applyLiveEvent` and rebuilt from replay steps, so a live stream and a replayed window reach identical rail facts. Unknown still prints `—`; nothing is estimated. |
| `turn` is the LARGER of the descriptor's reported turn and the assistant messages this window has seen, and the RAIL and the PROMPT read the same derived fact. | Both authorities count the same thing, both only grow, and neither sees all of it: the observed count alone reported `1` for a child opened at turn 9, and the snapshot alone never moved. The maximum is the best lower bound either source supports. The prompt once read the descriptor turn directly, so one frame printed `turn 3` under a rail saying `turn 7`, and a reader had no way to tell which counter described the child they were steering. |
| The SPEND group states the LATEST authoritative host usage report for the child, never a sum of reports. The input-side figure is whatever the host's `totalTokens` does not attribute to output, so the two printed figures add back up to it; cost is that report's own `cost.total`. The delegation tree's aggregate and Pi's cumulative `UsageTotals` remain the fallbacks for a window that has seen no report of its own, and an unknown still prints `—`. | **This corrects an earlier claim in this record that `message_end.message.usage` can never be authoritative.** It can, and it is the only figure that agrees with the host. Real 0.84.2 evidence: the latest report was `input 2, output 22, cacheRead 38798, totalTokens 38909, cost.total 0.0205`, and the parent's delegation card printed exactly `38.9k tok · $0.02` from it. A report is not a slice of the run that could be added up — every turn re-sends the whole conversation, so each report is the run SO FAR, priced again, with `cacheRead` carrying the context the host re-read. That is why the earlier reading looked wrong from both ends: `input` and `output` alone are one turn's NEW tokens (`in 2 · out 101`), a fraction of the run, while summing reports counts the whole context once per turn. The same delegation-tree aggregate that summed them reported `in 8 · out 244 · $0.0868` against the host's own `38909` and `$0.0205`, so an aggregate that disagrees with the latest report is not preferred over it. |
| Money reaches the rail only by being READ from `Usage.cost.total`, on the standalone `usage` event or on the terminal assistant message, and is never derived from token counts. | `projectAssistantUsageFacts` now projects that one field, bounded, alongside the token counts, so a replayed page and a live stream price a run identically. Only the host's own total is admitted: the breakdown's per-component figures are not printed, and a report that states tokens but no cost leaves cost to the fallback rather than pricing the tokens itself. |
| A tool payload is normalized to its safe TEXT before any row or rail cell sees it: pi-ai content blocks resolve to the prose they wrap, a `ToolResultMessage`'s correlation fields (`role`, `toolCallId`, `toolName`, `isError`, `timestamp`) are dropped from the result, and the closed projection's own withheld sentence is treated as absent. | A real Pi answer is `{ role: "toolResult", …, content: [{ type: "text", text }] }` passed through the reducer-visible privacy allowlist. Summarizing it verbatim printed the SHAPE (`⎿ type: text, text: …`, `role: toolResult, toolCallId: …`) and printed the privacy fallback as if it were data (`bash(command: Tool result details unavailable.)`), which reads as a command the child actually ran. Withheld detail is stated as `done` or `failed`, never as prose the adapter invented. |
| A carried MESSAGE is read for the tool facts it states: an assistant message's own `{ type: "toolCall", id, name, arguments }` blocks open or fill the call they name, and a `ToolResultMessage` — whose correlation lives on the message, not in a content block — settles that call by `toolCallId`. Arguments are adopted and never cleared, and a terminal answer settles a call exactly once, only while it is still pending. | A native session file holds messages, not events, so this is the ONLY carrier of a persisted run's tool story, and Pi replays the same two shapes to a live listener as `message_start` / `message_end` pairs. Reading only events left a real 0.84.2 run rendering `running`, `running`, `done` for three finished calls with no error tone on the failure, while each `ToolResultMessage` was mistaken for an assistant turn and printed the bash tool's own `(no output)` under a `● shuttle · reply` header the child never wrote. Reading the message role is what separates the two, structurally: a child that genuinely writes the words a tool would write still reaches the screen as its own reply. Adopting arguments from every carrier fixes the adjacent defect where a call whose opening event never arrived printed `bash()` for the rest of the run. |
| At settlement the mounted transcript is RECONCILED against the authoritative session: one bounded newest page, mapped, deduped, bounded and replayed, exactly as a freshly opened settled child loads. A page with no entries, or a source that cannot answer, reconciles nothing. | A live window is assembled from whatever events reached this listener, and that is not the same thing as the run. The session file is the authority for what the child actually did, and settlement is the moment it becomes complete. The two guards matter as much as the read: an unwritten or unreadable session may not erase a transcript the reader watched arrive, and reading position is preserved because reconciliation replaces the facts under the window, not the window. |
| A terminal tool event settles the call it names — by the id on the event OR the id inside the `ToolResultMessage` it carries — and only an event that names no call at all may settle the newest still-PENDING call. | A settled call that still reads `⎿ running` is the surest sign the inspector lost track of a call, and the previous fallback took the newest tool entry outright, so a second answer could overwrite a call that had already answered. `isError` is honoured on the event and on the message, so a failure reported only by the message still renders a `⎿` error outcome. |
| A child's `extension_ui_request` renders zero transcript rows, and an assistant message with no visible text, no visible reasoning, no caret and no classified failure renders zero rows. | A status line or working indicator is a request to paint the HOST's chrome, not conversation; `· child ui widget` was bookkeeping wearing a transcript row. A tool-use turn is an assistant message whose reply IS the tool rows below it, so a bare `● shuttle · reply` header over nothing announced a message the reader could not read. Streaming stays visible while empty, because the caret is the message. |
| Settlement re-reads the descriptor from the same tree the parent's delegation card reads, and `resolveThreadIdForLiveChild` answers only for a RUNNING child. | A thread outlives the run that opened it so it can be resumed, so answering from the thread map alone reported every settled child as live forever: the parent card said `COMPLETED` while the open inspector kept a `LIVE` frame, a frozen elapsed time and an editable prompt. Settlement also announces its own tree change rather than waiting for a refresh tick that may never come, and a still-running child's descriptor is re-read on the same tree change the card repaints on, so elapsed time, turn and spend move with the run and agree in the one final frame. |
| A `message_update` that carries neither an answer delta nor raw thinking states NOTHING: it produces no card fact and no transcript row. | Pi 0.84 sends the whole assistant lifecycle through `message_update`, so `text_start`, `text_end` and every `toolcall_*` frame reached a mapper that treated any non-text update as reasoning. The delegation card therefore printed `↳ reasoning` while the child was streaming its answer, and printed it again the instant `text_end` closed the answer it had just written — the reader's last line before settlement described thinking that had finished minutes earlier. Only `thinking_start` / `thinking_delta` / `thinking_end` (and the legacy `delta.thinking`) are genuine reasoning, and they still yield the content-free marker, never prose. |
| The overlay window entry for a message in flight carries the ACCUMULATED answer plus ONE canonical `message_update` replay step, not the last delta. | Every window reconstruction — a trim, an older/newer page merge, a search that fetches pages — rebuilds the transcript by replaying entries, and a lifecycle whose only retained step was `message_start` came back empty while the child was still answering. Replay compaction collapses same-message updates onto one stage, so a thousand deltas cost one slot, and the terminal `message_end` sits on its own stage and REPLACES the accumulated text on rebuild instead of appending to it. |
| A live child's descriptor carries the child's own answer-only snapshot (`streamedAnswer`), and an inspector opened MID-STREAM adopts it as a provisional, unframed assistant row. | The deltas that built the answer were delivered before the overlay mounted, and no bounded source can replay them: an inspector opened at that moment showed a `● shuttle · reply` header over nothing. The snapshot is the same 4 KiB preview the card and the picker already read, so it adds no surface and — by construction — no chain-of-thought, because the child accumulates only text deltas into it. It is adopted only for a live child, only when no lifecycle is already in flight, and only when no retained entry already states that text; a later genuine `message_start` takes the provisional row over, so a partial can never survive beside the real message. |

## 6. Related contracts

- [Spec 33 — Pi child sessions](33-spec-pi-adapter.md)
- [Spec 33 smoke checklist](33-smoke-checklist.md)
- [Spec 33 threat model](33-threat-model.md)
- [Pi adapter](../../adapters/pi.md)
- [Adapter boundary](../../architecture/adapter-boundary.md)
</content>
