# 33 — Pi private child sessions: inspection, persistence, and parent-result boundary

Status: active. Owner: Pi adapter.
Implementation issue: [#21](https://github.com/weave-io/weave/issues/21).

This specification governs private Pi child execution from spawn to completion.
Its purpose is to give private children durable inspection while keeping private
transcript content adapter-local.

This document **amends** prior private-child clauses in earlier Spec 33 text.
The amendments below are normative and supersede the named rules without
changing unrelated execution authority:

- §11: replace ephemeral `pi --mode rpc --no-session` with persisted,
  adapter-owned sessions; replace the transient 4 KiB inspector view with
  durable switchable history.
- §18: replace the private-child no-persistence rule with the bounded local
  persistence, quota, quarantine, and clear contract in §§3–7.
- §28: replace blanket private-child no-auto-resume with recovery only for
  eligible interrupted **ordinary top-level** children. Workflow resume remains
  a fresh attempt, not process recovery.
- §7 controller-generation staleness and one-shot settlement remain unchanged: stale generations cannot control or settle a child, and each child has exactly one terminal settlement.

No section in this document requires a human review or approval gate for
implementation or execution. The operational cancellation and recovery choices
specified below are direct child controls, not a review or approval workflow.

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

- `recovery_countdown_seconds` default: `10`.
- On startup, show one no-timeout recovery popup with the explicit choices:
  - `Recover now`
  - `Skip`
  - `Inspect`
- `Inspect` leaves the child recoverable in the picker.
- `Skip` suppresses immediate recovery and keeps the child history-visible and recoverable through the picker or `/weave:recover-children`.
- Countdown expiry starts recovery without another prompt; it never waits for review or approval.
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
  (default: `~/.local/share/weave/adapters/pi/child-history/<parent-session-id>/`).
- Directory mode: `0700`.
- File mode: `0600`.
- The V1 format is `index.v1.json` at the parent root, one
  `<child-id>/session.jsonl` append-only event stream per child, and one
  `<child-id>/checkpoint.v1.json` active-branch/checkpoint record. Index and
  checkpoint writes are atomic; each JSONL entry is complete and bounded.
- A missing or v0 index is treated as empty history and upgraded to V1 on the
  first successful write; an unknown version, malformed index, or failed
  migration is quarantined with bounded metadata and no raw content in errors.
- No-follow, descriptor-relative I/O for all read/write operations.
- No path traversal and no symbolic-link dereference outside the root.

### 7.3 Quota and trim

- Enforce `max_bytes_per_child` and `max_bytes_total` after each append.
- On overflow, trim oldest complete history but keep active branch integrity.
- Trim must not drop active view and inspected view unless a single child alone
  exceeds its own cap.
- Trimming creates an explicit trim marker entry visible in history views.

### 7.4 Quarantine and corruption handling

- Unknown version, malformed index, malformed JSONL, malformed checkpoint,
  symlink, oversized entry, or root replacement is quarantined. A missing or v0
  index follows the migration rule in §7.2 and is not an error.
- Quarantined entries are never treated as recoverable execution authority.
- Quarantine metadata is bounded and index-local.

### 7.5 Orphan and clear

- Orphaned records (missing parent session link) are pruned after
  `orphan_retention_days`.
- `/weave:clear-children` clears terminal records only; running/queued children
  cannot be physically cleared.
- Clear deletes session bytes and terminal index references for affected children.

## 8. Parent-result and export boundary

The only bounded export is a child index plus the terminal assistant
`finalOutput` projection and existing numeric metadata. The export contains no
session path, checkpoint, branch payload, or raw event.

The following values are private to the adapter-owned history and must never
cross into the parent model, controller/workflow result, Runtime Store, journal,
logs, health, failures, recovery pointers, telemetry, diagnostics, acceptance
proof, smoke artifacts, package exports, or network/remote sync:

- full raw transcript and intermediate assistant messages
- thinking text
- prompts, task text, and sanitized previews derived from them
- tool arguments, tool calls, tool results, and images
- intervention/steering/follow-up text
- extension UI payloads, editor text, notifications, widgets, and dialogs
- private session paths, checkpoints, branch contents, and raw RPC bodies

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

Private-child persistence, transport, recovery, and UI relay use this closed
failure-code set:

- `ChildSchemaInvalid` — an event, index, or setting violates its schema.
- `ChildCheckpointInvalid` — a checkpoint is malformed or cannot be restored.
- `ChildTransferTimedOut` — an authenticated transfer exceeded its deadline.
- `ChildTransferRejected` — the child rejected an authenticated transfer.
- `ChildTransferTooLarge` — a logical transfer exceeded `64 MiB`.
- `ChildNativeRecordTooLarge` — a native JSONL record exceeded `8 MiB`.
- `ChildControlEnvelopeTooLarge` — a signed control body exceeded `64 KiB`.
- `ChildDeliveryFailed` — a bounded delivery or write failed after retry.
- `ChildHistoryQuotaExceeded` — quota enforcement could not complete safely.
- `ChildHistoryQuarantined` — history was isolated after a safety failure.
- `ChildHistoryCorrupt` — stored history cannot be parsed or migrated.
- `ChildHistoryClearRefused` — clear targeted a running or queued child.
- `ChildRecoveryUnavailable` — recovery lacks a trusted eligible record.
- `ChildInteractionUnavailable` — steering, follow-up, or UI relay is unavailable.
- `ChildExtensionUiRejected` — an extension UI response was stale, cross-child,
  or not accepted by the originating child.
- `ChildSettlementMissing` — execution truly never settled; valid bounded or
  transferred output must never be reported with this code.

## 10. Control surface

The adapter exposes these commands to users:

- `/weave:inspect`
- `/weave:clear-children`
- `/weave:recover-children`
- `/weave:resume` for workflow attempts

No additional child-specific command may restart or override controller authority.

## §11. Amendment of the original private-child session and view rule

The following earlier §11 rules are **amended and replaced**, not additive:

| Superseded rule | Normative replacement |
| --- | --- |
| Spawn private children with `pi --mode rpc --no-session`. | Spawn with an explicit `--session-dir` under the adapter-owned path in §2 and persist the V1 history format in §7.2. |
| Expose only a transient 4 KiB inspector view and discard child history. | Expose the durable, switchable views, native/fallback rendering, slots, picker, and per-view state in §§4–5; retain bounded history under §§7.1–7.5. |
| Treat child inspection as a parent-output-only projection. | Keep full private content in the local adapter inspector only; export only the fields in §8. |

No implementation may apply a superseded rule alongside its replacement.
Controller-generation checks, force-kill boundaries, and one-shot settlement are
not amended.

## §18. Amendment of the original private-history and persistence rule

The earlier §18 private-child rule that prohibited persistence is **amended and
replaced**. Private history is now local adapter state, never engine state:

- The storage path, permissions, format, lifecycle, quotas, trimming,
  quarantine, orphan pruning, and clear behavior are exactly §§3 and 7.
- `/weave:clear-children` physically deletes session bytes and terminal index
  references only; running and queued records are refused and remain intact.
- The Pi adapter owns discovery and all session I/O. The engine never scans the
  history root and receives no session path, transcript, checkpoint, or raw
  event.
- `persist_history = false` disables new history writes and recovery while
  preserving the running child and bounded settlement contract; it does not
  permit fallback writes to Runtime Store, logs, or telemetry.

This amendment does not change controller-generation staleness or one-shot
settlement.

## §28. Amendment of the original restart and auto-resume rule

The earlier §28 blanket prohibition on private-child auto-resume is **amended and
replaced** by §6:

- Only interrupted ordinary top-level children with `recovery_enabled = true`
  are recovery candidates.
- Nested descendants and workflow-step children remain history-only; workflow
  `/weave:resume` creates a fresh authorized attempt.
- Recovery uses the current trusted descriptor, model, policy, limits,
  generation, and authentication. It cannot reuse old execution authority.
- Startup recovery has one no-timeout popup, a `10`-second countdown, and the
  exact choices `Recover now`, `Skip`, and `Inspect`; expiry starts recovery
  without a further review or approval step.

No other command, picker action, or persisted record may bypass these rules.

## 29. Related contracts

- [ADR 0013 — Pi Private Child Sessions](../adr/0013-pi-private-child-sessions.md)
- [Adapter boundary](../architecture/adapter-boundary.md)
- [Pi adapter implementation issue #21](https://github.com/weave-io/weave/issues/21)
