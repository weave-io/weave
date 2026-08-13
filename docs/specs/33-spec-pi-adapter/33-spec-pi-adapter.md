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

## 6. Compact `weave_delegate` block

Each delegation run renders one compact native-style tool block.

- The block is fixed at a three-line collapsed tail.
- While running, the tail shows only the latest meaningful raw non-whitespace
  activity fragment. Whitespace-only and control-only fragments are skipped.
- When expanded, the block shows the current item in full.
- On settlement, the block shows the final assembled response tail, or the error
  summary.
- Thinking output and tool noise must never be presented as the final response.
  The final tail comes only from the §10 result contract.
- The block exposes no filesystem path and no native session ID.
- Rendering uses Pi's normal render scheduling and the parser-approved child
  event flow, with stable per-item IDs, deduplication, and placeholder slots for
  out-of-order arrival. Settlement drains final events before classification.
- All child-sourced text is sanitized for terminal control sequences before
  render.
- Nested delegation renders the same compact block.
- Render failures are isolated: a degraded native block is shown and the child
  run is unaffected.
- Each run gets a new block. A prior run's block is frozen and is never mutated
  or unfrozen.

## 7. Full-screen child overlay

One centered, bordered Pi overlay renders the complete child transcript, live
and historical, above the still-visible parent UI. There is exactly one overlay
instance; opening another child swaps content instead of stacking, and nested
children open into the same overlay.

Required content, in order: the originating prompt first, then user messages,
assistant text, thinking, tool calls and results, errors, retry dividers, and
images, composed with native components through the opaque TUI/theme port.

Required behavior:

- Live children stream through the §6 event reducer; historical children load
  bounded pages from the native session file with cursors in both directions.
  The overlay must never load an entire large transcript.
- Search operates over the loaded window and fetches further pages on demand.
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
  and `Alt+Enter` submits a follow-up. Settled children are read-only with an
  explicit banner.
- The overlay row budget matches Pi's percentage floor, vertical margins, and
  top-only `maxHeight` truncation. It removes transcript rows before the owned
  editor or bottom border can be clipped on a short terminal.
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
- The header renders exactly one telemetry row for the focused child: provider,
  model, context percentage, and input/output token counts. Values come only
  from bounded, parser-approved host usage reports and existing model metadata.
  Only the latest report is retained, per child, replacing the prior one; runs
  are never summed. A field the host did not report authoritatively, or reported
  outside its pinned bounds, renders `—`. No value may be estimated: a missing
  context window means no percentage, never `0%`.
- The overlay offers a per-child view mode of `full` or `compact`, defaulting to
  `full`. Compact renders bounded one-line entry summaries. Compact is a
  render-time projection only: it must not fork, drop, or rewrite entry state.
  Toggling discards the measured scroll extent to force a re-measure and
  restores the viewport from a stable anchor, so a large row-count change cannot
  jump the viewport. Draft, search state, and per-child isolation survive a
  toggle.
- A renderer failure falls back to the existing custom-editor inspection path
  with the same transcript.
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
| Close inspection | `Escape` | Closes the overlay and leaves the child running |
| Cancel subtree | empty-draft `q` / `Q` | Opens the cancel-subtree confirmation |
| Toggle compact view | `Ctrl+O` | Switches the focused child between `full` and `compact` |

`Escape` is consumed by the overlay and must never fall through to Pi while the
overlay is mounted. It closes inspection and never cancels.

`q` and `Q` are matched semantically and are never registered as host shortcuts,
so typing `q` outside the overlay, or into a non-empty overlay draft, keeps its
ordinary meaning. The key opens the confirmation only on an empty draft over a
live focused child; a settled, orphan, or absent target reports no target rather
than prompting for nothing. The confirmation lists **Keep running** first and
defaults to it. Only the explicit **Cancel subtree** choice cancels, through the
existing subtree-cancel authority; no new authority is introduced. The
generation guard is re-checked after the modal resolves. Non-empty `Backspace`
edits draft text.

`Ctrl+O` is non-printable and is offered to the same conflict port as every other
overlay key. When the host already owns it, the route is skipped, the toggle is
not advertised in the help rows, and the conflict is reported once as a bounded
diagnostic line. The key is never taken over.

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
- Each run renders a new compact block; the prior run's block stays frozen (§6).
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
the live full overlay, live compact overlay, historical full and compact views,
custom-editor fallback, and parent-facing summary. Structured 429 and 5xx facts,
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
exports, or network/remote sync:

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

- Host version floor stays `0.81.1`, with no maximum. The Pi-native live proof
  target is Pi `0.84.1`.
- Required host probes remain persistent RPC session and restore, `appendEntry`,
  `get_entries`/`get_tree`, and custom session directory support.
- Pi-native readiness is not a capability descriptor and has no authority outside
  the Pi adapter. Before generation activation, the adapter proves the real
  `SessionManager.create` and `SessionManager.open` API, the fixed private root,
  and the Pi process launch surface. The externally visible capability remains
  `delegated-specialist-execution`.
- A failed proof enters health-only mode before config materialization, persistent
  session mutation, lease acquisition, or process spawn. It reports exactly one
  path-free reason: `pi-session-api-unavailable`,
  `pi-session-root-unavailable`, `pi-session-root-unsafe`, or
  `pi-process-unavailable`. There is no `descriptor-relative-native-session-io`
  capability, `path-only-session-api` reason, unsafe flag, environment override,
  or config override.
- The same readiness proof gates production `children.delete` before writable
  diagnostics initialize. Read-only status, health, history, inspection, doctor,
  list, and show routes do not initialize writable state.
- An overlay-only capability gap does not force health-only mode; it routes to
  the existing custom-editor fallback (§7).

## 17. Superseded rules

The following earlier rules are amended and replaced, not additive. No
implementation may apply a superseded rule alongside its replacement.

| Superseded rule | Normative replacement |
| --- | --- |
| Spawn children with `pi --mode rpc --no-session`. | Persistent native Pi v3 sessions under the §2 root, isolated from Pi's default tree. |
| Persist an adapter-owned JSONL store with `index.v1.json`, per-child `checkpoint.v1.json`, quotas, trimming, quarantine, and orphan pruning. | Native session files plus bounded parent refs (§4) and a derivative metadata cache (§5); explicit cleanup with tombstones only (§2). |
| Migrate or quarantine prior V1 history. | No migration (ADR 0014). Weave neither reads nor deletes prior JSONL history. |
| Expose only a transient 4 KiB inspector view and discard child history. | Compact block (§6), full-screen overlay (§7), picker and keys (§8). |
| Cancel a child subtree with a double `Escape` within `750 ms`. | `Escape` closes inspection only; empty-draft `q` / `Q` opens the cancel confirmation (§7, §8.1). |
| Blanket prohibition on private-child auto-resume. | Explicit thread retry and continue with ownership, capacity, and integrity semantics (§9). |
| Settings `persist_history`, `max_bytes_per_child`, `max_bytes_total`, `orphan_retention_days`, `recovery_enabled`, `recovery_countdown_seconds`. | Removed. Storage is native, unquota'd, and cleaned up explicitly. |

Controller-generation checks, force-kill boundaries, one-shot settlement, and the
export boundary in §13 are not amended. `/weave:resume` for workflow attempts
remains a fresh authorized attempt and never reuses a prior attempt's execution
authority.

## 18. Related contracts

- [ADR 0014 — Pi Native Child Sessions](../../adr/0014-pi-native-child-sessions.md)
- [ADR 0013 — Pi Private Child Sessions](../../adr/0013-pi-private-child-sessions.md) (superseded in part)
- [Spec 33 threat model](33-threat-model.md)
- [Spec 33 smoke checklist](33-smoke-checklist.md)
- [Adapter boundary](../../architecture/adapter-boundary.md)
- [Pi adapter](../../adapters/pi.md)
- [Pi adapter implementation issue #21](https://github.com/weave-io/weave/issues/21)
