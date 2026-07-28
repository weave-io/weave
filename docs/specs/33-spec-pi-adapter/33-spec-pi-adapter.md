# 33 — Pi private child sessions: inspection, persistence, and parent-result boundary

Status: active. Owner: Pi adapter.
Implementation issue: [#21](https://github.com/weave-io/weave/issues/21).

This specification governs private Pi child execution from spawn to completion.
Its purpose is to give private children durable inspection while keeping private
transcript content adapter-local.

This document **amends** prior private-child clauses in earlier Spec 33 text:

- §11: replace ephemeral `pi --mode rpc --no-session` with persisted sessions.
- §11: replace transient 4 KiB inspector view with durable switchable history.
- §7 and general restart behavior: remove blanket prohibition on private-child
  auto-resume; add recovery only for eligible interrupted **ordinary top-level**
  children.

No section in this document requires any user review, approval, or confirmation
as part of the child-inspection flow.

## 0. Non-negotiable invariants carried over

- Authentication, nonce/sequence checks, and one-shot settlement remain required.
- Force-kill and failure boundaries remain unchanged.
- `ControllerGeneration` staleness rules remain unchanged: stale generations are
  rejected for control and settlement.
- The controller may not reuse private-child session records to override durable
  execution authority.

## 1. Three transport and projection limits

All three limits are normative and must stay distinct:

| Limit | Frozen value | Owner |
| --- | --- | --- |
| Native JSONL record cap | `8 MiB` | Pi protocol (`child-framing.ts`) |
| Signed control-body cap | `64 KiB` | Weave security envelope (`child-envelope.ts`) |
| Logical transfer cap | `64 MiB` | Weave transfer protocol (`child-transfer.ts`) |
| Parent output projection | `4 KiB` | Parent-facing `assistantOutput` and `outputByteLength` |

Any attempt to exceed one cap must fail through a typed protocol failure; no child
result may fall through to `ChildSettlementMissing`.

## 2. Private-child spawn contract (amendment)

Private children are spawned with an adapter-owned persisted history directory:

- Session path: `$XDG_DATA_HOME/weave/adapters/pi/child-history/<parent-session-id>/`
  (default: `~/.local/share/weave/adapters/pi/child-history/<parent-session-id>/`).
- Child directory names are stable and derived from the child id.
- Parent process keeps only a reference to the child id and branch pointer.
- Each child runs with an explicit `--session-dir` to the adapter-owned history
  location.
- A child process may still be short-lived or queued by existing delegation policy,
  but every private child has a private-history anchor path at creation.

## 3. Private-history state and status model

Each private child has exactly one canonical status in the adapter index:

- `running`
- `queued`
- `settled`
- `interrupted`
- `quarantined`
- `cleared`

Record `kind` is one of `ordinary`, `nested`, or `workflow-step`.

A child must keep its latest status transition consistent with process and parent
inputs:

- start → `running`
- queued entry and explicit admission → `running`
- successful completion path → `settled`
- explicit stop or runtime interruption while awaiting resume → `interrupted`
- validation/failure to parse/migrate/corrupt events, hostile root mutation,
  malformed storage, or unknown version → `quarantined`
- clear operation on terminal records → `cleared`

Settled or cleared children are not live for capacity accounting.

## 4. Deterministic child inspector state model

Every private child has a persisted, switchable inspector record containing:

- `status`
- current branch pointer
- one-way checkpoint cursor for replay
- user draft text and per-view UI state (scroll offset, markdown/usage expansion,
  thinking visibility, queued follow-up queue length)
- last seen breadcrumb/title

View selection uses these rules:

1. Stable slots `Alt+1` through `Alt+9` map only to **live, non-queued**
   children.
2. A slot is assigned when the child enters `running` and held until the child
   leaves live state.
3. Slot assignment skips queued and terminal states.
4. Picker selection does not change slots.
5. Completed children remain available in history navigation even when not slotted.

## 5. Interaction and rendering contract

### 5.1 Rendering policy

Pi-native rendering is preferred when host export probes show native components.
When unavailable, the adapter must render a fallback that exposes the same
information.

Required event classes visible in every view:

- user task/task preview (sanitized, width-aware, and bounded preview text)
- assistant text and thinking
- tool calls, arguments, tool partial results, and tool errors
- images
- usage data
- queue / current tool status
- extension UI: notifications, widgets, dialogs
- breadcrumb/title including parent chain and workflow metadata
- one-line global status summary (no raw task text)
- continuation/interruption/recovery markers

### 5.2 Interaction rules

- `Enter` sends steering text to the running child.
- `Alt+Enter` appends follow-up text to running child queue.
- Completed views are read-only.
- Child slash commands are rejected unless the command is one of:
  - `/weave:inspect`
  - `/weave:clear-children`
- Empty `Backspace` returns parent context.
- Non-empty `Backspace` edits draft text.
- `Escape` confirms subtree-cancel request for the active child, including:
  child id, current tool, and all known descendants.
- Child UI must not inject parent text or transcript into private child tasks.

### 5.3 Navigation contract

- `Alt+I` opens hierarchy picker.
- `/weave:inspect` opens hierarchy picker.
- Picker lists active and historical private children with sanitized preview.
- Picker exposes recovery actions where allowed and resume actions for
  workflow-step descendants only.

## 6. Child recovery contract

### 6.1 Auto-recovery scope

Only this class is auto-recovery eligible:

- ordinary children
- top-level under the same parent session
- status `interrupted`
- recovery setting enabled

All other interrupted private children remain history-only.

### 6.2 Recovery policy

- `recovery_countdown_seconds` default: `10`
- On startup, show one recovery popup with the explicit choices:
  - `Recover now`
  - `Skip`
  - `Inspect`
- `Inspect` leaves the child recoverable in picker.
- `Skip` suppresses immediate recovery and keeps only history visibility.
- If countdown expires with `Recover now` still pending, recovery starts.
- A recovered run uses current trusted descriptor/model/policy/limits.
- Recovery reuses only the prior session path and checkpoint pointer; it does not
  bypass generation checks.

### 6.3 Workflow continuation

`/weave:resume` is a fresh attempt. It never reuses prior workflow process as
continuing authority and never claims old attempt state as current execution.

## 7. Persistence, quotas, retention, and clear semantics

### 7.1 Settings

`child_inspection` accepts these exact keys with these defaults:

- `persist_history = true`
- `max_bytes_per_child = 4_194_304`
- `max_bytes_total = 67_108_864`
- `orphan_retention_days = 30`
- `recovery_enabled = true`
- `recovery_countdown_seconds = 10`

### 7.2 Storage layout and I/O safety

- Root path: `$XDG_DATA_HOME/weave/adapters/pi/child-history/<parent-session-id>/`
- Directory mode: `0700`
- File mode: `0600`
- No-follow, descriptor-relative I/O for all read/write operations.
- No path traversal and no symbolic-link dereference outside the root.

### 7.3 Quota and trim

- Enforce `max_bytes_per_child` and `max_bytes_total` after each append.
- On overflow, trim oldest complete history but keep active branch integrity.
- Trim must not drop active view and inspected view unless a single child alone
  exceeds its own cap.
- Trimming creates an explicit trim marker entry visible in history views.

### 7.4 Quarantine and corruption handling

- Unknown version, missing index, malformed JSONL, malformed checkpoint, symlink,
  oversized entry, or root replacement is quarantined.
- Quarantined entries are never treated as recoverable execution authority.
- Quarantine metadata is bounded and index-local.

### 7.5 Orphan and clear

- Orphaned records (missing parent session link) are pruned after
  `orphan_retention_days`.
- `/weave:clear-children` clears terminal records only; running/queued children
  cannot be physically cleared.
- Clear deletes session bytes and terminal index references for affected children.

## 8. Parent-result and export boundary

The parent receives only bounded terminal output projection plus explicit numeric
metadata.

Never export or persist outside the adapter-owned history:

- full raw transcript
- intermediate assistant messages
- thinking text
- tool arguments
- tool calls/results
- prompts or task text
- intervention text
- extension UI payloads or events

Adapter-facing controller/workflow completion uses:

- `assistantOutput`: bounded by parent projection cap
- `completionCandidate`: direct-step completion JSON only when applicable
- `outputTransferId` and `outputByteLength` metadata when a private transfer is
  used
- existing numeric metadata already defined by delegation metadata contract

No other child content crosses into Runtime Store, journals, logs, health,
failures, recovery pointers, telemetry, diagnostics, acceptance proof, or smoke
artifacts.

## 9. Failure-code namespace for child inspection

Private-child persistence and transport must raise closed codes, including and
not limited to:

- `ChildTransferTimedOut`
- `ChildTransferRejected`
- `ChildTransferTooLarge`
- `ChildDeliveryFailed`
- `ChildHistoryQuotaExceeded`
- `ChildHistoryQuarantined`
- `ChildHistoryCorrupt`
- `ChildHistoryClearRefused`
- `ChildRecoveryUnavailable`
- `ChildInteractionUnavailable`
- `ChildSettlementMissing` only when execution truly never settled.

## 10. Control surface

The adapter exposes these commands to users:

- `/weave:inspect`
- `/weave:clear-children`
- `/weave:recover-children`
- `/weave:resume` for workflow attempts

No additional child-specific command may restart or override controller authority.

## 11. Replacement summary (amendments)

The following earlier rules are explicitly replaced:

1. **Ephemeral child sessions** (`--no-session`) are replaced by persisted,
   private-session directories at `$XDG_DATA_HOME/weave/adapters/pi/child-history/`.
2. **Transient inspector views** are replaced by durable, switchable child views
   with slot and picker navigation.
3. **Blanket no-auto-resume** is replaced by constrained ordinary-top-level
   recovery with explicit countdown handling.

The parent-projection rule, controller-generation staleness, and one-shot
settlement semantics remain in force.

## 12. Related contracts

- [ADR 0013 — Pi Private Child Sessions](../adr/0013-pi-private-child-sessions.md)
- [Adapter boundary](../architecture/adapter-boundary.md)
- [Pi adapter implementation issue #21](https://github.com/weave-io/weave/issues/21)
