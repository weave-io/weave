# 33 — Pi child sessions: native persistence, inspection, and parent-result boundary

Status: active. Owner: Pi adapter.
Implementation issue: [#21](https://github.com/weave-io/weave/issues/21).

This specification governs Pi child execution from spawn to completion. Its
purpose is to give delegated children durable native persistence and full
inspection while keeping child transcript content adapter-local.

The storage, layout, migration, quota, and pruning rules in this document derive
from [ADR 0014 — Pi Native Child Sessions](../../adr/0014-pi-native-child-sessions.md),
which supersedes those parts of [ADR 0013](../../adr/0013-pi-private-child-sessions.md).
ADR 0013 remains in force for adapter ownership of discovery, transport,
rendering, steering, and the engine privacy boundary.

Historical note, non-normative: earlier revisions of this specification
described an adapter-owned JSONL child-history store with an `index.v1.json`
index, per-child `checkpoint.v1.json` records, byte quotas, trimming, orphan
pruning, and a quarantine state. That store is removed. There is **no migration**
from it: Weave neither reads, converts, quarantines, nor deletes prior on-disk
JSONL history. No implementation may apply any part of that superseded model.

No section in this document requires a human review or approval gate for
implementation or execution. The operational cancellation, retry, and continue
choices specified below are direct child controls, not a review or approval
workflow.

## 0. Non-negotiable invariants carried over

- Authentication, nonce/sequence checks, and one-shot settlement remain required.
- Force-kill and failure boundaries remain unchanged.
- `ControllerGeneration` staleness rules remain unchanged: stale generations are
  rejected for control and settlement.
- The controller may not reuse child session records to override durable
  execution authority.
- Each child has exactly one terminal settlement.

## 1. Three transport and projection limits

All limits are normative and must stay distinct:

| Limit | Frozen value | Owner |
| --- | --- | --- |
| Native JSONL record cap | `8 MiB` | Pi protocol (`child-framing.ts`) |
| Signed control-body cap | `64 KiB` | Weave security envelope (`child-envelope.ts`) |
| Logical transfer cap | `64 MiB` | Weave transfer protocol (`child-transfer.ts`) |
| Parent output projection | `4 KiB` | Parent-facing `assistantOutput` and `outputByteLength` |

Any attempt to exceed one cap must fail through a typed protocol failure; no
child result may fall through to `ChildSettlementMissing`.

## 2. Native child session layout

Every delegated child runs in a persistent native Pi v3 session.

- Session root: `$XDG_DATA_HOME/weave/adapters/pi/sessions/`
  (default: `~/.local/share/weave/adapters/pi/sessions/`).
- Pi's `SessionManager.create` supplies the generated native path, exact v3
  header, session ID, parent, and working directory. Because Pi defers the first
  write, the adapter exclusively creates the validated `0600` leaf with that
  exact generated header plus one newline. It then calls `SessionManager.open`
  and revalidates the path and all identity fields before spawn. The adapter must
  never fabricate or normalize a v3 or fork header.
- The root is fixed. The adapter launches the child with both
  `--session <validated-file>` and `--session-dir <validated-directory>` and
  removes inherited `PI_CODING_AGENT_SESSION_DIR`; Pi settings or environment
  state cannot redirect the explicit directory. The child never writes into Pi's
  default session tree.
- Child sessions must never appear in Pi's `/resume` list and are not a
  supported target for manual native Pi CLI access.
- Directory mode `0700`, file mode `0600`. Sessions are user-only.
- All session I/O is strictly contained under the adapter's trusted path
  boundary. Canonical immediate-child equality, no-follow traversal, leaf type,
  ownership, mode, and link-count checks reject traversal, symbolic links, hard
  links, replacement, and root escape. No session path crosses into the engine,
  parent result, health, diagnostics, lifecycle, Runtime Store, logs, or model.
- Read-only consumers open a session file once and read it through that
  descriptor in bounded positional chunks of at most 64 KiB. Each production
  range read performs at most one OS `pread`; a short read is resumed by a
  fresh range call so held-fd and leaf checks surround every content read.
  Content is never read by name after that first resolution, so a rename or
  replacement after validation cannot redirect a read.
- Around every positional chunk, the directory leaf is re-verified with
  no-follow, directory-relative metadata against the open descriptor's
  identity, mode, and link count. A rename, atomic replacement or exchange,
  deletion, symlink replacement, added hardlink, or mode change of the leaf
  fails closed with a typed error and no partial projection.
- A whole-session descriptor read is bounded before allocation. The descriptor's
  own size is checked against a hard 8 MiB ceiling before any body byte is read;
  a larger file fails closed as `file-too-large`. An initially empty file still
  performs a guarded EOF probe and final held-fd/leaf verification before
  returning empty; concurrent growth or leaf swap during that probe fails closed
  with no empty projection. Line and entry budgets apply while chunks stream in,
  not after the file is in memory. A non-empty final line without a trailing
  newline counts toward the 32,768-line ceiling, and the ceiling is enforced
  before any chunk is concatenated or parsed.
- Descriptor identity (`dev`, `ino`, `size`, `mtime`) is captured at open and
  re-verified after every chunk. Growth, truncation, replacement, or in-place
  rewrite during a read returns a typed error and no partial transcript.
- Each child session records the originating parent session through Pi's
  `parentSession` link. The link is set at creation and is immutable.
- Session creation must succeed before the child task starts. A persistence
  failure fails the delegation; the adapter must never fall back to an ephemeral
  non-persistent child.
- Removal is explicit only. There is no automatic pruning, no age-based expiry,
  and no quota-driven deletion. Production deletion is available only after the
  same Pi-native readiness proof as delegation, resolves a selected terminal
  child, removes its verified session, and appends a tombstone record; tombstones
  append and never rewrite or truncate prior records. Read routes stay read-only.
- A missing or unreadable session resolves to a typed unavailable state that the
  UI presents with repair or remove options. It is never treated as recoverable
  execution authority.
- Deleting a parent session leaves its children as read-only orphans that remain
  visible to history and doctor surfaces.

## 3. Child status model

Each child has exactly one canonical status:

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`
- `tombstoned`

Record `kind` is one of `ordinary`, `nested`, or `workflow-step`.

Transitions:

- start, or admission from `queued` → `running`
- valid terminal response (§10) → `completed`
- typed failure → `failed`
- explicit cancel, including subtree cancel and session-transition cancel →
  `cancelled`
- explicit delete of a terminal child → `tombstoned`

Only `queued` and `running` children hold capacity. Settlement releases capacity
regardless of outcome. `max_children` caps children running in parallel, never
the cumulative number ever executed.

## 4. Parent child refs

The parent session carries bounded custom entries that reference its children.
Refs are **observations**: they record identity and lifecycle, and they are never
recovery authority. No API may use a ref to resurrect, re-authorize, or mutate a
child in the absence of the authoritative child session file.

### 4.1 Ref schema

Each ref is schema-validated, strictly bounded, and versioned. Fields:

| Field | Meaning |
| --- | --- |
| `threadId` | Opaque logical child/thread identifier; stable across runs |
| `nativeSessionId` | Native Pi session identifier for the child |
| `sessionRef` | Root-relative reference to the child session under §2 |
| `originParentSessionId` | Originating parent session ID; immutable |
| `originEntryId` | Originating parent entry ID; immutable |
| `title` | Bounded display title (§8.2 precedence) |
| `status` | Canonical status from §3 |
| `createdAt`, `updatedAt`, `settledAt` | Lifecycle timestamps |
| `runs` | Run count and per-run lifecycle metadata |

Bounds are enforced by schema. Validation failure yields a typed
`ChildRefInvalid` result; a malformed entry is skipped with a typed issue and
never aborts a scan.

### 4.2 Content limits

- Refs carry metadata only. Raw messages, prompts, task text, thinking, tool
  arguments, tool results, and images must never enter a ref.
- Refs must never contain absolute filesystem paths.
- A parent must not write refs for children it does not own.

### 4.3 Origin authority

- `originParentSessionId` must equal the live parent session ID for a ref to be
  usable.
- Refs copied by fork, clone, or any other session duplication therefore fail the
  origin check. They are excluded from picker, history, and every lifecycle
  action, and confer no history and no authority.
- Excluded refs are reported to doctor as an informational count. They are never
  adopted and never silently presented as owned children.

## 5. Derivative metadata cache

Discovery uses an adapter-owned SQLite cache.

- The cache is **not authoritative**. Parent session entries and child session
  files are the authority; the cache must be fully rebuildable from them.
- The cache stores metadata only: thread ID, native session ID, origin parent
  session and entry IDs, title, status, timestamps, run count, and workspace
  scope key, plus a schema-version record. It must contain no transcript field
  and no parent content.
- The cache file lives under the adapter root with directory mode `0700` and
  file mode `0600`, strictly contained.
- Reads consult source first for any specific child; source disagreement marks
  the cached row stale.
- A corrupt, unreadable, or version-drifted cache yields a typed degraded mode
  in which callers fall back to bounded direct entry scans. Cache absence or
  degradation must never block delegation, settlement, inspection, or the
  overlay.
- Every query is scoped by workspace and parent lineage keys. Cross-scope
  results are a defect.
- Delete and tombstone events update the cache. Tombstoned children remain
  listed as tombstones and are not resurrectable.

## 6. Inline `weave_delegate` delegation card

Each delegation run renders one framed inline **delegation card** in the
parent's own Pi transcript. The normative geometry, vocabulary, drop order, and
honesty rules are recorded in the
[Weave UI design record](33-weave-ui-design.md) and enforced by
`prototypes/weave-delegate-tool-grilling.ts`.

Structure:

- Exactly one card per run, drawn by the registered `weave_delegate` tool
  through `renderResult` with `renderShell: "self"`. The adapter appends no
  transcript entry and registers no entry renderer for the card.
- Exactly one top edge (`╭─ weave_delegate ─…─╮`) and one bottom edge per card.
  No second border, and no corner glyph inside the card.
- Collapsed height is four to six rows at every width, and does not change at
  settlement. Settlement changes words, never geometry.
- A narrow ten-column **status-first rail** on the left carries the state word
  in upper case behind a toned bar, then the child agent name, then elapsed.
  The state word and the child name survive every width; elapsed is the rail's
  only droppable cell.
- The right body carries one **assignment** row — one imperative sentence in the
  parent's own words, with no provenance prefix, acceptance clause, scope field,
  or routing rationale — and beneath it exactly one **Native Line**. During live
  child work that line is the raw reasoning projection
  `↪ reasoning • <text>`; it is absent when no printable reasoning is available.
- The bottom edge is a **balanced edge footer**: run, lifecycle phase, elapsed,
  tokens, and cost on the left, and `Ctrl+O expand · Alt+I inspect child` on the
  right. The action side is measured first, so an affordance always outlives a
  number, and `Alt+I` is the last hint to drop. The footer prints the lifecycle
  phase, never the status word the rail already owns.
- Expanded, the card adds one interior rule and a fixed-height **child
  viewport**: one status strip reading `LIVE · following bottom` while the child
  can still act and `AT BOTTOM · child settled` once it cannot, plus
  `↑ N rows above` when scrollback exists, over exactly nine literal bottom
  card rows. The viewport contains only card-owned assignment, lifecycle,
  terminal framing, and the live reasoning projection; child assistant/tool
  activity and payload are never shown or relabelled there.

Behavior:

- The card registers no keybinding. `Ctrl+O` is Pi's own tool-expand action and
  `Alt+I` is the existing Weave picker action (§8.1); both are printed as hints
  only. The expand verb is `expand` while running and `details` once settled.
- While running, the Native Line is the only child-activity projection and is
  exactly `↪ reasoning • <text>`. The source is parser-approved generic Pi
  `thinking_start`, `thinking_delta`, and `thinking_end` text. The card hides
  assistant output, tool names and status, arguments, results, stdout, stderr,
  and inspector payload. It uses one TUI-only, process-memory buffer capped at
  `4 KiB` UTF-8, one parent line capped at `240` code points, and the `100 ms`
  repaint coalescer. Terminal-control normalization is the only text filter.
  Non-empty omitted text ends with `… [truncated]`; non-printable input uses
  `[unprintable reasoning]`; no blank reasoning row is emitted.
- The settled `weave_delegate` tool result still carries the authoritative child
  output and the §10 failure semantics. That API result is not a live card
  activity projection. Raw reasoning never enters tool-result `content`, card
  `details`, parent messages, or parent model input. The card's persisted view
  contains only bounded content-free facts and card framing; bounded sanitized
  tool arguments/results and live assistant text remain inspector-only.
- Settlement is **native**: the authoritative settlement rewrites the rail state
  word and footer verb, clears the transient reasoning line, and adds no
  assistant/tool row, banner, border verdict, or action deck. The authoritative
  child output remains in the settled tool API result, not as card activity.
  Nothing on the card ever offers retry, steer, resume, or cancel, in any state.
- Settlement is the only completion authority. A `message_end` never produces a
  completed card, a settled state, or a success glyph; the final text comes only
  from the §10 result contract.
- A failed card prints the already-redacted reason with no stack frame, absolute
  path, secret, or provider payload. Recovery is named only where the failure
  class is documented as recoverable. A cancelled card names the initiator in
  safe terms, says the partial work was kept and that nothing was verified, and
  never claims success.
- The card exposes no filesystem path and no native session ID.
- The card's persisted `details` payload is versioned, bounded, and strictly
  parsed; a foreign, older, or oversized payload degrades to a bounded, framed,
  honest fallback card instead of throwing. Re-rendering from persisted details
  after a replay or restart reproduces the final live frame.
- The model-visible `content[0].text` stays a bounded activity line and never
  carries card chrome.
- Rendering uses Pi's normal render scheduling and the parser-approved child
  event flow, with stable per-item IDs, placeholder slots for out-of-order
  arrival, and duplicate suppression only where the host states an event's
  identity. Matching text is never treated as identity, so a repeated answer
  delta is kept. Inspector assistant deltas are accumulated as the exact ordered
  concatenation of what the child sent, bounded to the shared preview budget,
  and sanitized once for display. Reasoning uses a separate live-only buffer and
  must not share the assistant or durable reducer state. Updates are coalesced
  through the injected timer port, and run start, tool error, provider error,
  queue change, and settlement always publish immediately. Settlement drains
  final events before classification and always flushes.
- What one `message_update` states is decided by a single mutually exclusive
  classification shared by every consumer: answer text, a live-only reasoning
  update plus its content-free retained fact, framing that states nothing, or a
  typed rejection. A frame that declares an answer carrier and a raw-reasoning
  carrier at once is rejected fail-closed — it produces no text or live
  reasoning update on any surface. A carrier is judged by what it HOLDS, not by
  the type it declares: prose under a `thinking` / `reasoning` member, or in a
  nested thinking content block, makes a `text_delta` or `answer` frame a
  raw-reasoning carrier too, and a carrier the bounded descriptor-safe scan
  cannot read is rejected. Only generic `thinking_start` / `thinking_delta` /
  `thinking_end` carries live reasoning; no summary type or derived summary is
  a substitute.
- Every Weave-owned durable path asks one shared retention decision and keeps
  the same parser-approved content-free event for generic thinking: the
  transcript reducer, replay-step builder, rebuild, search, serialization, and
  native-session read path used by Weave. The live reasoning projector is a
  separate authenticated fanout before retention; it alone receives the bounded
  display text. A `message_update` the classification REJECTED is retained
  nowhere: it appends no history event, projects no retained entry, pushes no
  replay step, and hands no payload to the history port. A classified reasoning
  frame becomes only the canonical content-free event
  `{ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }`
  on those durable paths. No nested member, string, block, partial, usage
  subobject, accessor, or unknown field survives there. An unambiguous answer
  and pure framing are retained unchanged. An event the parser refuses is
  likewise retained nowhere — history records the checkpoint with no payload.
  The live text is never copied into Weave Runtime Store records, checkpoints,
  transcript/replay/search state, parent messages or model input, card details,
  logs, diagnostics, artifacts, reports, or files.
- All child-sourced text is sanitized for terminal control sequences before
  render, and box-drawing glyphs are reachable only through the frame
  primitives, so child text structurally cannot forge a frame.
- Nested delegation renders the same card through the same renderer. There is no
  second card path.
- Render failures are isolated: a degraded card is shown and the child run is
  unaffected.
- Each run gets a new card. A prior run's card is frozen and is never mutated or
  unfrozen.

## 7. Child inspector overlay

One centered Pi overlay — the **child inspector** — renders the complete child
transcript, live and historical, above the still-visible parent UI. There is
exactly one overlay instance; opening another child swaps content instead of
stacking, and nested children open into the same overlay. The normative layout
is recorded in the [Weave UI design record](33-weave-ui-design.md) and enforced
by `prototypes/weave-pi-tui-grilling.ts`.

Required structure, in order:

- Exactly one high-contrast titled outer frame wraps the overlay and carries the
  live state marker. No second frame is drawn, and no fake transcript, editor,
  or footer is drawn outside it.
- A two-row **session header**. Row 1 is an inverse ` CHILD ` badge, the child
  agent name, the child's model, its role, and its bounded task title, all on
  the left. Row 2 is `delegated by <PARENT>` followed by plan › task › subtask.
  The header carries no telemetry row and no child ID. The model sits
  immediately after the child's name and appears exactly once. Growth is
  two-row before the title is dropped; row 2 sheds subtask first, then plan.
- A **Pi-native transcript pane** on the left: role gutters, understated read /
  edit / bash calls and results, the live raw-reasoning row, and plain streaming
  and final assistant responses. Generic Pi `thinking_start`, `thinking_delta`,
  and `thinking_end` text renders only through the bounded live projector as
  `↪ reasoning • <text>`. Required content, in order: the originating prompt
  first, then user messages, live reasoning, tool calls and results, the live
  assistant reply, errors, retry dividers, and images, composed with the opaque
  TUI/theme port. The child ID may appear only on the transcript's
  bootstrap row. Retained generic-thinking events remain content-free.
- A **Status Matrix rail** on the right: an aligned key/value matrix grouped
  into lifecycle, work, and spend, with an inverse alert pair above the matrix
  when a tool fails. The rail is the only place child telemetry appears. Below
  the width at which the rail and the transcript minimum both fit, the rail
  folds to its compact matrix form.
- A **primary-like editor** below both panes: a bordered input panel over one
  muted key row. A settled child gets the same editor, read-only and caretless.
  A disabled key prints an explicit `✕`, not only dim colour, so a settled child
  reads as unactionable on a monochrome terminal.
- The **cancel confirmation** replaces the editor in place. It is answered
  inside the overlay and never through a surface the overlay does not own.

Required behavior:

- Live children stream through the §6 event reducer and a separate transient
  reasoning projector; historical children load bounded pages from the native
  session file with cursors in both directions. The overlay must never load an
  entire large transcript or reconstruct raw reasoning from native-session
  history.
- Search is **rail search**: `/` on an empty draft prepends a SEARCH section to
  the Status Matrix, the transcript grows a two-column marker gutter, `n` / `N`
  (aliases `j` / `k`) move the rail cursor, and the shared transcript window
  follows. `Enter` jumps to the current match and latches the anchor. Search
  operates over the loaded window and fetches further pages on demand. The match
  list is built from an ANSI-free twin render, so no byte of transcript colour
  can paint the search rail.
- A committed search is bound to the child it was committed against and to a
  monotonic search revision. Editing the query, committing again, closing
  search, re-opening search on the query it already committed, opening a child,
  re-opening the SAME child, and closing the overlay all move that revision on,
  before anything repaints or returns. Both facts are re-checked after every
  await, so a page that arrives for a superseded search is a NO-OP: it may not
  merge into the window, merge its ids into the counter, move the viewport,
  return its own child, or turn a failed read into the custom-editor fallback.
  It resolves to the view the reader is actually looking at, or to
  `OverlayNotOpen` when the overlay is closed. Typed query preview stays
  synchronous and window-only.
- The surface applies that rule to the jump and the fallback IT owns, using the
  same reading rather than a local approximation of it: the controller
  publishes its committed-search revision as one read-only epoch, and a
  committed run carries that epoch alongside the child it started on. A run
  whose epoch, child, or run identity is no longer current may not focus the
  viewport, may not collapse the inspector into the fallback, and may not hold
  the surface busy. Busy is the CURRENT run's own state, never a count of
  pending reads: a committed page read has no timeout, so an abandoned one may
  stay pending forever and must not block steering, follow-ups, or paging once
  the run the reader is waiting on has answered.
- Live-tail follows new output, disengages on manual scroll, and resumes at the
  bottom. Resize reflows. PageUp, PageDown, Shift+Up, Shift+Down, Home, and End
  must be matched semantically, never by raw byte comparison, so legacy CSI,
  Kitty event-aware, and SS3 (`ESC O H` / `ESC O F`) encodings of the same key
  all scroll. Kitty release frames do not repeat an action. When the newest
  page still fits the overlay (`scrollExtent` 0) but older history exists,
  PageUp and Home must load the older page and leave live tail so the prepended
  rows become visible. A global expansion toggle applies to all entries.
- The ownership-independent terminal-input route that carries scroll frames must
  prove its liveness by installation, never by inference from an unchanged host
  object. The host may clear extension listeners while keeping the same context,
  so each bind must release any handle it holds and subscribe again, keeping the
  handle that subscription returned. Superseded closures must be made inert so a
  host that fails to remove a listener cannot double-deliver a frame.
- Run and branch navigation uses run-divider metadata (§9).
- For active children, a fresh overlay-owned Pi `CustomEditor` owns cursor
  movement, deletion, multiline input, and the draft. `Enter` submits steering
  and `Alt+Enter` submits a follow-up. Settled children are read-only and
  caretless; the outer frame marker and the rail carry the state word, and no
  banner band, rail verdict section, transcript checkpoint block, or action deck
  is added.
- Settlement adds no chrome. The authoritative final response, the safe failure
  line, the cancellation record, and the retry record are ordinary transcript
  events. Recovery stays live, and its attempt lineage is read in the transcript
  and on the rail. The inspector keeps one live reasoning buffer capped at
  `4 KiB` UTF-8, renders at most three reasoning rows, and coalesces repaints at
  `50 ms`. It uses terminal-control normalization only; non-empty omitted text
  ends with `… [truncated]`, non-printable text uses `[unprintable reasoning]`,
  and no blank reasoning row is rendered.
- The overlay row budget matches Pi's percentage floor, vertical margins, and
  top-only `maxHeight` truncation. It removes transcript rows before the owned
  editor or bottom border can be clipped on a short terminal. A narrow or short
  terminal always keeps the key row that says how to leave.
- The overlay owns the keyboard while mounted; focused input must never leak to
  the primary editor. Drafts and scroll positions are preserved per child. The
  overlay never borrows or replaces the primary editor, so pi-vim and other
  foreign editors remain untouched through mount and unmount.
- `Escape` closes inspection only. One press closes the overlay, restores the
  parent's focus, and leaves the inspected child running. `Escape` must never
  cancel a child, arm a cancel hint, or fall through to Pi while the overlay is
  mounted. Search-mode `Escape` leaves search only.
- Cancellation is a separate explicit route (§8.1). Only an explicit confirm
  choice cancels a subtree; dismissal, an absent choice, or a select failure
  leaves the child running.
- The Status Matrix rail is the sole telemetry surface for the focused child:
  provider, model, context percentage, input/output token counts, elapsed, queue
  depth, turn, and spend, grouped as lifecycle, work, and spend. Values come only
  from bounded, parser-approved host usage reports and existing model metadata.
  Only the latest report is retained, per child, replacing the prior one; runs
  are never summed. A field the host did not report authoritatively, or reported
  outside its pinned bounds, renders `—`. No value may be estimated: a missing
  context window means no percentage, never `0%`. The header must not regrow a
  telemetry row.
- Ambient parent context is owned by the Plan Rail widget above the parent's own
  editor (§4 of the design record): the selected primary agent with its `Alt+A`
  cycle hint, the plan name, spaced task marks with the task ordinal, and
  explicit `now` and `next` rows. It reads parent-side facts only, so it
  structurally cannot print a child ID, token count, cost, elapsed time, or
  queue depth, and it is byte-identical in every child state. No duplicate task
  footer is published beside it.
- The rail's display-only foreground plan identity is adopted from a direct
  interactive request only after the HOST proves the turn started: Pi's
  `before_agent_start` must report that same submission's prompt. The adapter's
  own `input` decision records pending intent and adopts nothing, the first
  proof spends that intent whatever it proves, and an unsubmitted, superseded,
  session-replaced, or unrelated turn adopts nothing. `/weave:start`, which
  submits its own kickoff turn, adopts inside the success arm of
  `sendUserMessage` instead, because that call is its dispatch proof.
- Plan refreshes coalesce onto one lookup, and the queue keeps the latest
  request with its own session context, so a refresh belonging to a replaced
  session can never clear or drop a newer session's queued repaint.
- A renderer failure falls back to the existing custom-editor inspection path
  with the same transcript. The inspector shows raw reasoning, bounded sanitized
  correlated tool arguments/results, and the live assistant reply. One tool
  call updates one row from running to terminal state; the tool and assistant
  reducers remain independent of reasoning success.
- The inspector reasoning buffer exists only in process memory and is cleared on
  focus change, close, settlement, generation replacement, component disposal,
  and session shutdown. Saved state, source ports, replay, search, checkpoints,
  Runtime Store, logs, diagnostics, proof output, and files contain no raw
  reasoning. Pi's host-managed native child session may retain it under Pi's
  rules, but Weave never duplicates that host data.
- Pi does not enable terminal mouse reporting, so wheel events cannot reach the
  overlay. Mouse-wheel scrolling is outside this contract until Pi exposes a
  mouse input surface.

## 8. Picker, keys, and hierarchy navigation

### 8.1 Named configurable keys

Every binding is a named, configurable Pi action with a default. Conflicts with
existing user keybindings are reported as a diagnostic and are never overwritten.

| Action | Default | Behavior |
| --- | --- | --- |
| Open picker | `Alt+I` | Opens the hierarchy picker |
| Select active child | `Alt+1`..`Alt+9` | Indexes active children in stable tree order |
| Sibling navigation | `Alt+Left` / `Alt+Right`, `Alt+H` / `Alt+L` | Moves between siblings |
| Parent navigation | empty `Backspace` | Moves to parent, or closes the overlay when opened directly |
| Scroll the transcript | `PageUp` / `PageDown`, `Shift+Up` / `Shift+Down`, `Home` / `End` | Matched semantically in legacy, Kitty, and SS3 encodings |
| Steer the focused child | `Enter` | Submits the draft to a live child |
| Queue a follow-up | `Alt+Enter` | Queues the draft behind the current turn |
| Close inspection | `Escape` | Closes the overlay and leaves the child running |
| Cancel subtree | empty-draft `q` / `Q` | Opens the in-overlay cancel-subtree confirmation |
| Open rail search | empty-draft `/` | Prepends the SEARCH section to the rail and shows the marker gutter |
| Next / previous match | `n` / `N` (aliases `j` / `k`) | Moves the rail cursor while search is open; the transcript window follows |
| Accept match | `Enter` while search is open | Jumps to the current match and latches the anchor |
| Close search | `Escape` while search is open | Leaves search only |

Key precedence inside the overlay is stated once and never reordered:
**cancel confirmation › search › overlay**. While the confirmation is open only
`y`, `n`, and `Escape` are read, so `n` unambiguously means no. Movement keys
exist only while search is open, so they can never collide with the
confirmation. With search open, `Escape` leaves search only; with both closed,
`Escape` closes the overlay.

`Escape` is consumed by the overlay and must never fall through to Pi while the
overlay is mounted. It closes inspection and never cancels.

The overlay claims no search key that the host owns. Rail search is always
reachable through the empty-draft `/` route. `Ctrl+F` is offered as a
conflict-safe alias that opens search whatever the draft holds, and it is
routed only when the same conflict port reports the key free. Pi normally binds
`Ctrl+F` to `tui.editor.cursorRight`, so the alias is normally skipped and
reported once, naming the current owner, the usual owner, and the surviving `/`
route. Losing the alias never removes search.

`Ctrl+O` is Pi's own tool-expand action. Weave declares no overlay action for it
and registers no binding: it expands the §6 delegation card in the parent
transcript and is printed on the card footer as a hint only. `Alt+A` and `Alt+T`
are Weave's own primary-agent and plan-task shortcuts. They belong to the parent
surfaces, and because Pi dispatches extension shortcuts outside a focused
`ui.custom` component, they do not route while the overlay owns input; closing
the overlay restores them.

A key release is dropped before any route runs, so one physical press never acts
twice. Below the confirmation and search, the remaining order is overlay keys,
then the overlay's own draft editor.

`q` and `Q` are matched semantically and are never registered as host shortcuts,
so typing `q` outside the overlay, or into a non-empty overlay draft, keeps its
ordinary meaning. The key opens the confirmation only on an empty draft over a
live focused child; a settled, orphan, or absent target reports no target rather
than prompting for nothing. The confirmation lists **Keep running** first and
defaults to it. Only the explicit **Cancel subtree** choice cancels, through the
existing subtree-cancel authority; no new authority is introduced. The
generation guard is re-checked after the modal resolves. Non-empty `Backspace`
edits draft text.

Every overlay key is offered to the same conflict port. When the host already
owns a key, the route is skipped, the affordance is not advertised in the key
row, and the conflict is reported once as a bounded diagnostic line. A key is
never taken over.

### 8.2 Picker contract

- Lists children in all statuses with title and local timestamp.
- Ordering: active children first, then settled children newest-first.
- Title precedence: the declared agent name, then the explicit workflow step
  name, then the literal fallback label, always followed by an opaque suffix
  taken from the child's own thread id. Task text, prompt text, and transcript
  content never contribute to a title.
- Detail views use ISO timestamps; list views use local locale formatting.

### 8.3 Durable title provenance

A durable title is written into parent and thread refs, cached in SQLite,
reconstructed after restart, and shown in the picker, `/weave:history`,
`/weave:doctor`, and the adapter CLI. Refs and cache rows written by earlier
adapter versions stored a bounded first line of the delegated task, so a stored
title is prompt content unless its origin is proven.

Proof is an explicit versioned provenance marker persisted beside the title,
never the shape of the title itself:

- Every record created from trusted identity metadata persists the marker
  `trusted-identity-v1`. The marker set is closed; a new meaning of "trusted"
  requires a new version, not a redefinition.
- Parsers accept a record with no marker so legacy rows still load, but such a
  record is unproven: its stored title is replaced by `child-<opaque suffix>`
  before the record exists as a value, so no sink can observe the original.
- A marker outside the closed set is invalid data and is rejected by the record
  schema, exactly like any other malformed field.
- A record whose title is replaced is re-marked, because the fallback is itself
  derived only from identity. Enforcement is therefore idempotent: a proven
  title is returned byte-identical and never drifts across ref, cache,
  reconstruction, picker, history, doctor, or CLI boundaries.
- Structural resemblance to a derived title proves nothing. A legacy row whose
  task text reads exactly `<label>-<this row's own suffix>` is still suppressed.

The metadata cache stores the marker in a dedicated `title_provenance` column.
Schema v2 adds that column; a v1 database is migrated forward in place when it
is opened for writing, and rows carried across the migration have no marker and
are therefore treated as unproven.

## 9. Thread lifecycle: start, retry, continue

`weave_delegate` accepts an optional thread action. Absent thread fields preserve
today's start semantics exactly.

- **start** — existing `{agent, task}` call. Creates a new thread, a new logical
  child, and a new native session.
- **retry** — allowed for a retryable `failed` thread or a `cancelled` thread.
  Uses a default bounded continuation instruction, or an optional caller
  instruction.
- **continue** — allowed for a `completed` thread. A task is required; omitting
  it is a validation error, never a defaulted instruction.

Rules:

- All runs of a thread share one logical child and one native session. Each run
  reopens the active leaf and appends a run-divider entry carrying run number,
  action, timestamp, prior outcome, model, reasoning setting, and initiator.
- Each run renders a new delegation card; the prior run's card stays frozen (§6).
- Authority: the owner, or an authenticated ancestor holding an explicit
  transfer, may act on a thread. No other caller may.
- Capacity: a running retry or continue holds a `max_children` slot; settlement
  releases it (§3).
- State: the child's native model and agent state are preserved across runs. The
  current tool and skill policy is revalidated against live configuration at
  each run start.
- Results expose the opaque thread ID, run number, status, retryability, and the
  final response or error. Direct workflow children use the same provision, ref,
  native Pi session, terminal lifecycle, and tombstone rules; a reachable settled
  direct child records exactly one terminal lifecycle event instead of remaining
  `running`. Results must not leak filesystem paths or native session paths.
- Failures are structured: `ThreadAlreadyRunning`, `ThreadStale`,
  `ThreadIntegrityError`, `ThreadNotRetryable`.

## 10. Child result contract

A valid child result requires a parent-observed terminal assistant response with
non-whitespace content. The terminal assistant event's semantic `stopReason` is
authoritative over process exit and stderr. `stopReason: "error"` projects a
bounded provider error; non-provider tool failures do not.

Provider errors use one canonical sanitized shape and one canonical line across
the delegation card, the live child inspector, the historical child inspector,
the custom-editor fallback, and the parent-facing summary. Structured 429 and 5xx facts,
connection and timeout classifications, and safe provider identifiers may be
shown within fixed field and display bounds. Missing, malformed, JSON-only, or
unsafe details render `assistant error · details unavailable`. Raw payloads,
response bodies, arbitrary exception text, request data, and sentinel input must
not appear. A later successful terminal assistant event clears the stale error.
General DLP for secret-shaped tool call IDs or arbitrary credentials embedded in
ordinary tool output is outside this contract; those values remain governed by
the existing transcript boundary.


- Completion that is empty, whitespace-only, thinking-only, or tool-only does not
  satisfy the contract and settles as `ChildResponseMissing`.
- `ChildResponseMissing` is retryable. It preserves the child transcript, never
  truncating or deleting it, and releases capacity like any other settlement.
- Settlement drains final events before classification, so out-of-order terminal
  events cannot produce a false `ChildResponseMissing`.
- Length does not substitute for a response: long thinking blocks and large tool
  results never satisfy the contract.

## 11. Persistent parent requirement

- A parent without a persistent session (for example `--no-session`) cannot hold
  child refs and cannot own native child sessions.
- Delegation from such a parent fails with `PersistentParentSessionRequired`
  before any child session is created. Zero session files may exist as a result
  of a rejected attempt.
- The diagnostic states the cause and the remediation: start Pi with a persistent
  session.
- Read-only surfaces remain available where data is resolvable: picker, history,
  and doctor stay mounted. Steering, follow-up, retry, continue, and delete are
  disabled with the same diagnostic.

## 12. Parent session transitions and shutdown

- The adapter registers awaited pre-hooks on parent session transitions: new,
  resume, fork, clone, and branch/tree changes.
- If the parent owns active or queued descendants, the hook prompts with the
  default **Stay**.
- On a confirmed transition, the adapter cancels all active and queued owned
  descendants and awaits settlement metadata write-back to the **origin** refs
  before the transition proceeds. Settlement metadata is never written into the
  destination session.
- Hook failure vetoes the transition with a diagnostic.
- A new parent session shows no notice and no data from the previous session's
  children.
- Quit and reload perform a bounded cancel and then force-stop. No residual child
  process may remain.
- If a transition surface cannot be pre-hooked by the host, the gap must be
  detected by a capability probe (§16) and documented. Silent unguarded
  transitions are not acceptable.
- Fork and clone additionally rely on §4.3 origin rejection, so a copied branch
  starts with no children rather than borrowed ones.

## 13. Parent-result and export boundary

The only bounded export is the child identity plus the terminal assistant
`finalOutput` projection and existing numeric metadata. The export contains no
session path, branch payload, or raw event.

The following values are private to the adapter and must never cross into the
parent model, controller/workflow result, Runtime Store, journal, logs, health,
failures, telemetry, diagnostics, acceptance proof, smoke artifacts, package
exports, or network/remote sync. The sole live exception is the bounded
process-memory reasoning projection defined in §6 and §7; it is UI-only and is
released at its lifecycle edges:

- full raw transcript and intermediate assistant messages
- thinking text
- prompts, task text, and sanitized previews derived from them
- tool arguments, tool calls, tool results, and images
- intervention/steering/follow-up text
- extension UI payloads, editor text, notifications, widgets, and dialogs
- child session paths, branch contents, and raw RPC bodies

Adapter-facing controller/workflow completion uses:

- `assistantOutput`: bounded by the parent projection cap
- `completionCandidate`: direct-step completion JSON only when applicable
- `outputTransferId` and `outputByteLength` metadata when a private transfer is
  used
- existing numeric metadata already defined by the delegation metadata contract

## 14. Stable diagnostic codes

Diagnostics carry child, run, parent, and correlation IDs. They must never carry
raw prompt or transcript content; a sanitizer strips transcript-like fields
defensively.

Storage, refs, and cache:

- `ChildSessionRootViolation` — a path escaped the §2 root or failed no-follow I/O.
- `ChildSessionMissing` — the referenced child session file does not exist.
- `ChildSessionCorrupt` — the child session cannot be read or parsed.
- `ChildSessionPermissionError` — permissions on the root, directory, or file are unsafe.
- `ChildTombstoneAppendFailed` — a tombstone record could not be appended.
- `ChildRefInvalid` — a ref failed schema validation or bounds.
- `ChildRefOriginMismatch` — a ref's recorded origin does not match the live parent.
- `ChildCacheDegraded` — the metadata cache is unusable; callers fall back to source scans.
- `ChildCacheStale` — a cached row disagreed with source on access.

Execution and lifecycle:

- `PersistentParentSessionRequired` — the parent has no persistent session (§11).
- `ChildResponseMissing` — settlement produced no non-whitespace terminal assistant response (§10).
- `ThreadAlreadyRunning` — a run was requested while the thread is running.
- `ThreadStale` — the thread record no longer matches authoritative state.
- `ThreadIntegrityError` — ref, session, and run metadata are mutually inconsistent.
- `ThreadNotRetryable` — the thread's state does not permit the requested action.

Transport and settlement, unchanged:

- `ChildSchemaInvalid` — an event or setting violates its schema.
- `ChildTransferTimedOut` — an authenticated transfer exceeded its deadline.
- `ChildTransferRejected` — the child rejected an authenticated transfer.
- `ChildTransferTooLarge` — a logical transfer exceeded `64 MiB`.
- `ChildNativeRecordTooLarge` — a native JSONL record exceeded `8 MiB`.
- `ChildControlEnvelopeTooLarge` — a signed control body exceeded `64 KiB`.
- `ChildDeliveryFailed` — a bounded delivery or write failed after retry.
- `ChildInteractionUnavailable` — steering, follow-up, or UI relay is unavailable.
- `ChildExtensionUiRejected` — an extension UI response was stale, cross-child, or
  not accepted by the originating child.
- `ChildSettlementMissing` — execution truly never settled; valid bounded or
  transferred output must never be reported with this code.

## 15. Commands, dispatch boundary, and CLI

### 15.1 Extension commands

- `/weave:inspect` — opens the current parent's active lineage in the overlay or
  picker.
- `/weave:history` — bounded cross-session, all-branch history; the first page is
  shown before any wider discovery.
- `/weave:doctor` — runs diagnostics and returns a report to the caller.

`/weave:history` and `/weave:doctor` remain available and read-only in
health-only mode.

### 15.2 Engine dispatch boundary

The engine exposes a generic adapter-command dispatch: an opaque adapter name,
opaque command name, and opaque payload, returning an opaque result. The engine
validates envelope shape only. No Pi type, Pi session concept, or Pi output
parsing may appear in `packages/engine` or `packages/core`.

### 15.3 Bounded CLI

- `weave adapter pi children list` — newest `50` for the current workspace,
  metadata only.
- `weave adapter pi children show <id>` — newest `100` entries plus a cursor.
- `weave adapter pi children delete <id>` — requires interactive confirmation or
  `--yes`; appends a tombstone.
- `weave adapter pi doctor` — runs the same diagnostics as `/weave:doctor`.

Output is human-readable by default and stable JSON under `--json`; the JSON
shape is a stability contract. No filesystem path appears in any output except
behind an explicit diagnostic flag.

### 15.4 Doctor checks

Doctor is read-only. Repair and remove actions route through the explicit APIs in
§2 and §15.3, never as doctor side effects. Checks cover capability probes,
permissions, session/ref/cache integrity, stale markers, and a bounded orphan
scan. The report is returned to the caller only; the adapter writes no standalone
log file.

## 16. Capability probes and compatibility

- Host version floor stays `0.81.1`, with no maximum. The implementation
  targets Pi `0.84.2`'s public surfaces, and Task 15 is the exact real-host proof
  target for the optional runtime model fallback. Until that proof passes, Pi
  `0.84.2` is not a proven fallback host. Historical native-session proof
  material may name Pi `0.84.1`; it does not define the current fallback
  contract.
- Host version floor stays `0.81.1`, with no maximum. The Pi-native live proof
  target is Pi `0.84.2`.
- Required probes: persistent RPC session and restore, `appendEntry`,
  `get_entries`/`get_tree`, and custom session directory support.
- Pi addresses native sessions by filesystem path. Containment is proven by the
  adapter, not by the host: the adapter owns the session root, hands Pi the exact
  child directory, and accepts only a canonical immediate child of it. There is
  no descriptor-relative host capability.
- Delegation readiness is `delegated-specialist-execution`. A required
  host-surface gap reports exactly one closed, path-free reason:
  `pi-session-api-unavailable`, `pi-session-root-unavailable`,
  `pi-session-root-unsafe`, or `pi-process-unavailable`. Raw host messages,
  causes, paths, and method names never reach a public surface, and no
  environment variable or configuration setting raises readiness.
- While that capability is unavailable for one of those reasons, every
  persistent session mutation —
  delegation, direct workflow dispatch, retry, continue, steering, follow-up,
  cancellation, clear, recovery, and adapter CLI delete — fails with a typed
  `RequiredCapabilityUnavailable` result before any controller, session service,
  filesystem, cache, lease, or child process call. Read-only status, health,
  history, inspection, doctor, list, and show routes stay available.
- The same readiness proof gates production `children.delete` before writable
  diagnostics initialize. Read-only status, health, history, inspection, doctor,
  list, and show routes do not initialize writable state.
- Probes must be side-effect free; probing must not create a session.
- A missing required session capability puts the adapter in health-only mode with
  a diagnostic naming the capability, host version, contract, probe result, mode,
  and remediation.
- An overlay-only capability gap does not force health-only mode; it routes to
  the existing custom-editor fallback (§7).

### 16.1 Optional runtime model fallback

`runtime-model-fallback` is an optional, feature-only Pi host surface. It is not
an engine capability or a new `.weave` setting. The implementation targets Pi
`0.84.2`'s public surfaces, and Task 15 is the exact real-host proof target;
surface presence and automated tests do not substitute for that live proof. The
adapter probes these public surfaces: payloadless `agent_settled` registration,
terminal `message_end`, a replacement-returning `context` handler,
`message_start`, `model_select`, callable `setModel`, fire-and-forget
`sendMessage`, and callable idle and pending-message helpers. Static presence is
not proof of lifecycle ordering.

Pi owns its native retry, overflow-compaction, and queued-message recovery. It
emits payloadless `agent_settled` after those paths finish. This creates an
exact two-low-level-run compromise:

1. Pi internally settles the first low-level run.
2. Weave keeps the visible child, tool call, and session pending, selects the
   next eligible model, and starts a hidden public custom-message turn.
3. The turn runs in the same Pi process and native session. It is a new
   low-level run. Weave neither suppresses Pi's internal event nor replaces the
   process or session.

The recovery turn does not run `before_agent_start`. Weave calls public
`pi.setModel` and then invokes public `pi.sendMessage` with
`{ triggerTurn: true }`. The marker has custom type
`weave.model-fallback.recovery-marker`, fixed bounded content, `display: false`,
and strict details `{ schemaVersion: 1, token: <RFC 4122 version-4 UUID> }`.
Only `message_start` for that exact marker and token proves dispatch. The
`sendMessage` return value is not an acknowledgment. Missing marker proof fails
closed after a bounded timeout.

The public `context` handler receives a provider-only message clone. It removes
exactly two entries: the failed assistant immediately before the exact marker,
after matching the retained bounded assistant fingerprint and marker token. The
marker and failed assistant remain in durable native history. No synthetic
provider user message is inserted. Successful fallback output is a separate
assistant entry, so failed partial output cannot be concatenated with it.
Handlers registered after Weave receive Weave's filtered list as trusted
composition partners. This boundary does not isolate the session from a
malicious full-access extension that can inspect or rewrite the same context or
history.

Each explicit Weave agent activation freezes a distinct ordered candidate list,
with a bounded maximum of 64 entries. The cursor starts after the applied failed
model and never wraps. A manual, unmatched, delayed, duplicate, or ambiguous
`model_select` latches fallback off until explicit Weave agent activation;
ordinary turns do not clear that latch. Catalog misses and unavailable provider
authentication skip only the current candidate. For a context-overflow failure,
a candidate is eligible only when its declared context window is strictly
larger than the failed model's. Other failure classes do not use that rule. Once
Pi applies a model, Weave reports that applied model even if marker or context
proof later fails. A recovery-confirmed switch produces one read-only
`weave.model-failover` event; an applied-only switch and ordinary exhaustion
produce no Model Fallback event. The event and card geometry are normative in
the [Weave UI design record](33-weave-ui-design.md).

When any optional fallback surface is missing or unproven, the adapter keeps
health ready and uses legacy visible and child settlement. It does not enter
health-only mode and does not select the overlay fallback. The `0.81.1` floor
remains supported through the legacy path. The adapter makes no proven fallback
host claim for Pi `0.84.2` until Task 15's exact real-host proof passes.
### 16.1 Child-streaming verification boundary

The final live proof must use an exact identity gate before it asserts a UI
lane. Independently verify the source-input digest, built output digests,
path-free build manifest, loaded artifact digest, extension load time, and
process start time. A loaded process is current only when those values agree
with the on-disk artifact and manifest. The gate rejects stale-on-disk,
manifest-mismatch, corrupt, missing, and otherwise unverifiable states; file
modification time alone is not identity evidence. A build-A-loaded/build-B-on-
disk control, a corrupted manifest or output control, and a fresh-process
control are required.

The Pi `0.84.2` fixture is captured at Pi's public extension/RPC event boundary
through real Pi session machinery. It preserves event kind, own enumerable key
shape, value kind, ordering, lifecycle phase, tool correlation, bounded tool
arguments/results, and incremental assistant ordering. The capture omits generic
thinking text online before any write. It retains only the `thinking_start` /
`thinking_delta` / `thinking_end` structure, saturated byte/line counts, and a
truncation flag. No reasoning prefix, suffix, hash, encoded value, exception,
transcript, screenshot, or terminal capture is proof data. Replay may inject a
controlled reasoning string in memory only.

Diagnostics are content-free aggregates: closed stage and reason codes,
saturated counts, and bounded first/last times. They contain no reasoning,
assistant text, tool payload, credentials, paths, prompts, or exception text.
Replay and red controls cover stale identity, malformed or mixed carriers,
stale generation and wrong-child updates, bounds and truncation honesty,
terminal-control safety, durable-sink isolation, lifecycle release, missing
assistant deltas, broken tool correlation, duplicate terminal tools, and parent
card leakage. The four live lanes are parent raw reasoning live, inspector raw
reasoning live, inspector tool details, and inspector assistant reply live.

## 17. Superseded rules

The following earlier rules are amended and replaced, not additive. No
implementation may apply a superseded rule alongside its replacement.

| Superseded rule | Normative replacement |
| --- | --- |
| Spawn children with `pi --mode rpc --no-session`. | Persistent native Pi v3 sessions under the §2 root, isolated from Pi's default tree. |
| Persist an adapter-owned JSONL store with `index.v1.json`, per-child `checkpoint.v1.json`, quotas, trimming, quarantine, and orphan pruning. | Native session files plus bounded parent refs (§4) and a derivative metadata cache (§5); explicit cleanup with tombstones only (§2). |
| Migrate or quarantine prior V1 history. | No migration (ADR 0014). Weave neither reads nor deletes prior JSONL history. |
| Expose only a transient 4 KiB inspector view and discard child history. | Delegation card (§6), child inspector overlay (§7), picker and keys (§8). |
| Render each delegation run as a fixed three-line compact tool block with an expanded current item. | One framed inline delegation card with a status-first rail, an assignment row, the live `↪ reasoning • <text>` Native Line, a balanced edge footer, and a nine-row expanded card viewport with no child assistant/tool payload (§6). |
| Offer a per-child overlay view mode of `full` or `compact`, toggled in-overlay by `Ctrl+O`. | Removed. The overlay has one view; `Ctrl+O` is Pi's own tool-expand action for the §6 card and is never registered by Weave (§7, §8.1). |
| Render a header telemetry row for the focused child in the overlay. | Telemetry lives only on the Status Matrix rail; the header carries identity and parent context (§7). |
| Reach in-overlay search through `Ctrl+F` as the primary opener. | Rail search through empty-draft `/`, with `n` / `N` movement and `Enter` accept. `Ctrl+F` survives only as a conflict-checked alias that is normally skipped (§7, §8.1). |
| Publish a `weave-task` plan-task footer beside the plan widget. | The Plan Rail above the parent editor is the single owner of ambient parent context (§7, design record §4). |
| Cancel a child subtree with a double `Escape` within `750 ms`. | `Escape` closes inspection only; empty-draft `q` / `Q` opens the cancel confirmation (§7, §8.1). |
| Blanket prohibition on private-child auto-resume. | Explicit thread retry and continue with ownership, capacity, and integrity semantics (§9). |
| Settings `persist_history`, `max_bytes_per_child`, `max_bytes_total`, `orphan_retention_days`. | Removed with the old JSONL store. Current `child_inspection` settings `recovery_enabled`, `recovery_countdown_seconds`, and `keys` remain; they control inspection and are not runtime-model-fallback settings. |

Controller-generation checks, force-kill boundaries, one-shot settlement, and the
export boundary in §13 are not amended. `/weave:resume` for workflow attempts
remains a fresh authorized attempt and never reuses a prior attempt's execution
authority.

## 18. Related contracts

- [ADR 0014 — Pi Native Child Sessions](../../adr/0014-pi-native-child-sessions.md)
- [ADR 0013 — Pi Private Child Sessions](../../adr/0013-pi-private-child-sessions.md) (superseded in part)
- [Spec 33 Weave UI design record](33-weave-ui-design.md)
- [Spec 33 threat model](33-threat-model.md)
- [Spec 33 smoke checklist](33-smoke-checklist.md)
- [Adapter boundary](../../architecture/adapter-boundary.md)
- [Pi adapter](../../adapters/pi.md)
- [Pi adapter implementation issue #21](https://github.com/weave-io/weave/issues/21)
