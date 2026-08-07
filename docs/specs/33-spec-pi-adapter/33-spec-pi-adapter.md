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
- The root is fixed. The adapter passes it to the child as an explicit custom
  session directory; the child never writes into Pi's default session tree.
- Child sessions must never appear in Pi's `/resume` list and are not a
  supported target for manual native Pi CLI access.
- Directory mode `0700`, file mode `0600`. Sessions are user-only.
- All session I/O is no-follow and descriptor-relative, strictly contained under
  the root. Path traversal and symbolic-link dereference outside the root are
  rejected, not repaired.
- Read-only consumers open a session file once and read it through that
  descriptor in bounded positional chunks of at most 64 KiB. The validated leaf
  is never reopened by name, so a rename or replacement after validation cannot
  redirect a read.
- A whole-session descriptor read is bounded before allocation. The descriptor's
  own size is checked against a hard 8 MiB ceiling before any body byte is read;
  a larger file fails closed as `file-too-large`. Line and entry budgets apply
  while chunks stream in, not after the file is in memory.
- Descriptor identity (`dev`, `ino`, `size`, `mtime`) is captured at open and
  re-verified after every chunk. Growth, truncation, replacement, or in-place
  rewrite during a read returns a typed error and no partial transcript.
- Each child session records the originating parent session through Pi's
  `parentSession` link. The link is set at creation and is immutable.
- Session creation must succeed before the child task starts. A persistence
  failure fails the delegation; the adapter must never fall back to an ephemeral
  non-persistent child.
- Removal is explicit only. There is no automatic pruning, no age-based expiry,
  and no quota-driven deletion. Explicit deletion requires a confirmation token
  from the caller and appends a tombstone record; tombstones append and never
  rewrite or truncate prior records.
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

One full-screen overlay renders the complete child transcript, live and
historical. There is exactly one overlay instance; opening another child swaps
content instead of stacking, and nested children open into the same overlay.

Required content, in order: the originating prompt first, then user messages,
assistant text, thinking, tool calls and results, errors, retry dividers, and
images, composed with native components through the opaque TUI/theme port.

Required behavior:

- Live children stream through the §6 event reducer; historical children load
  bounded pages from the native session file with cursors in both directions.
  The overlay must never load an entire large transcript.
- Search operates over the loaded window and fetches further pages on demand.
- Live-tail follows new output, disengages on manual scroll, and resumes at the
  bottom. Resize reflows. A global expansion toggle applies to all entries.
- Run and branch navigation uses run-divider metadata (§9).
- For active children, `Enter` submits steering and `Alt+Enter` submits a
  follow-up. Settled children are read-only with an explicit banner.
- The overlay owns the keyboard while mounted; focused input must never leak to
  the primary editor. Drafts and scroll positions are preserved per child.
  Unmounting restores primary editor state, including pi-vim mode.
- A renderer failure falls back to the existing custom-editor inspection path
  with the same transcript.

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
| Cancel subtree | double `Escape` within `750 ms` | Opens the cancel-subtree confirmation |

`Escape` is consumed by the overlay and arms a hint; it must never fall through
to Pi while the overlay is mounted. The cancel-subtree confirmation defaults to
**Keep running**. Non-empty `Backspace` edits draft text.

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
  final response or error. Results must not leak filesystem paths or native
  session paths.
- Failures are structured: `ThreadAlreadyRunning`, `ThreadStale`,
  `ThreadIntegrityError`, `ThreadNotRetryable`.

## 10. Child result contract

A valid child result requires a parent-observed terminal assistant response with
non-whitespace content.

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

- Host version floor stays `0.81.1`, with no maximum.
- Required probes: persistent RPC session and restore, `appendEntry`,
  `get_entries`/`get_tree`, custom session directory support, and
  descriptor-relative native session I/O.
- Descriptor-relative native session I/O means every native session read and
  write is addressed by an opaque, host-owned session descriptor rather than by
  a caller-supplied filesystem path. Pi 0.83 exposes a path-only session API, so
  this probe reports `unavailable` with reason `path-only-session-api` and the
  adapter runs in health-only mode on that host. The probe is not overridable:
  session restore, custom session directories, and RPC method presence do not
  raise it, and no environment variable or configuration setting enables it.
- While that capability is unavailable, every persistent session mutation —
  delegation, direct workflow dispatch, retry, continue, steering, follow-up,
  cancellation, clear, recovery, and adapter CLI delete — fails with a typed
  `RequiredCapabilityUnavailable` result before any controller, session service,
  filesystem, cache, lease, or child process call. Read-only status, health,
  history, inspection, doctor, list, and show routes stay available.
- Probes must be side-effect free; probing must not create a session.
- A missing required session capability puts the adapter in health-only mode with
  a diagnostic naming the capability, host version, contract, probe result, mode,
  and remediation.
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
