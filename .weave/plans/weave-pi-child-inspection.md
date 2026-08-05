# Weave Pi Child Inspection (Confirmed Contract)

## TL;DR
Give every private Pi child — ordinary, nested, and direct workflow-step — a full Pi-like switchable view with steering, follow-up queuing, scoped extension UI, stable Alt slots, and a hierarchy picker, backed by bounded, private, local-only child session history with recovery. Add generic `settings.adapters.<harness>` DSL support so Pi can carry `child_inspection` settings without teaching core any Pi field.

## Context

**Current state.** The Pi adapter exposes only a bounded text child tree (`packages/adapters/pi/src/child-tree.ts`, `child-tree-render.ts`, `child-tree-keys.ts`) and a 4 KiB `latestOutput`. `packages/adapters/pi/src/rpc-child.ts` owns authenticated bootstrap, framing, one-shot settlement, cancellation, and force-kill, and discards full assistant messages, thinking, tool arguments/partial results, images, usage, queue state, errors, and extension UI events. Ordinary and nested children flow through `packages/adapters/pi/src/delegation-controller.ts`; workflow steps use `packages/adapters/pi/src/direct-dispatch-transport.ts` and `direct-dispatch.ts`. Both must feed one shared inspection/history service without merging their execution semantics — direct dispatch keeps its own completion authority and stays outside ordinary delegation budgets, and its bootstrap must keep authenticating with the generated `childId`.

**Reproduced oversized-output defect.** A native Pi child can emit a valid assistant RPC record larger than 1 MiB. The current one-size framing path treats that record as an oversized protocol failure, poisons the transport, and can surface `ChildSettlementMissing` instead of settling with the child's valid result. Native Pi RPC records need their own explicit, bounded record limit above 1 MiB and incremental handling. That limit is separate from the strict private control-envelope cap: a large native output must not be relayed as a private control envelope, and a valid record within the native-record bound must not poison transport or settlement.

**Spec 33 amendments required.** `docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md` currently mandates ephemeral `pi --mode rpc --no-session` children (§11, line ~341), a transient 4 KiB view that must not persist (§11, line ~387), and no auto-resume on restart (§7 line ~208, §18, §28 table line ~835). The confirmed contract supersedes those three rules for private children: sessions become locally persisted under an adapter-owned XDG path, views become durable and switchable, and interrupted *ordinary top-level* children become auto-recovery candidates behind an explicit countdown popup. §7's "no auto-resume of stale objects" survives unchanged for controller generations and workflow children.

**Rendering.** Compose Pi's native exported components (`AssistantMessageComponent`, `ToolExecutionComponent`, `Markdown`, `Image`, usage/queue/status components, theme and width helpers) when the host exports them; fall back to Pi-styled renderers otherwise, gated by host probes (`host-inventory.ts`, `capability-prober.ts`, `host-compatibility-matrix.ts`). Never build a second transcript engine.

**Privacy and parent-result boundary.** Private history is adapter-owned harness data, not engine Runtime Store data. It lives at `$XDG_DATA_HOME/weave/adapters/pi/child-history/<parent-session-id>/`, defaulting to `~/.local/share`. Directories 0700, files 0600, descriptor-relative no-follow I/O patterned after `packages/engine/src/runtime/nofollow-ffi.ts` and `packages/engine/src/runtime/sqlite/runtime-directory-guard.ts`. The complete private child transcript remains available only to the local inspector/history service. The parent receives only the bounded final assistant output extracted from the terminal assistant response plus existing numeric metadata, such as intervention counts and workflow numeric metadata. The parent must never receive or persist the transcript, intermediate assistant messages, thinking, tool calls or results, prompts, task text, images, intervention text, or extension UI events. Those private values must never enter `.weave/runtime`, journals, logs, health, failures, recovery pointers, telemetry, diagnostics, acceptance proof, or smoke artifacts.

**Core config.** `packages/core/src/schema.ts` has a typed `settings` block (log level, runtime, delegation) with no generic adapter map and no null AST value. `packages/config/src/merge.ts` already deep-merges plain objects; adapter settings reuse that normal layered behavior. Core enforces only JSON-like shape, depth 4, and 64 KiB per adapter block; the active adapter validates its own block.

**Worktree.** The tree is heavily dirty across core schema tests, Pi adapter source/tests, Spec 33, Pi guides, and release-manifest files. Re-read each file on disk before editing and apply minimal additive diffs. Never checkout, reset, stash, or regenerate over unrelated hunks. Capture a path-scoped baseline diff before work and compare after each phase.

**Issue linkage.** The active implementation issue is [#21 — `[adapter-pi] HarnessAdapter implementation`](https://github.com/weave-io/weave/issues/21); closed #121–#129 hold Pi planning history. Every PR description must mention #21 (`Refs #21`), per `AGENTS.md`.

**Supersedes.** `.weave/plans/weave-pi-live-child-inspection.md` is the earlier draft; this plan is the confirmed contract and takes precedence where they differ (notably command names, slot eligibility, follow-up queuing, and clear semantics).

## Scope

- In scope:
  - Full Pi-like switchable views for ordinary, nested, and direct workflow-step private children: task/user steering entries, text/Markdown/thinking, tool arguments and streaming results, errors, images, usage, queues, child notifications/widgets/dialogs, breadcrumb/title, one-line global status.
  - Stable Alt+1..9 slots for live non-queued children only; Alt+I and `/weave:inspect` hierarchy picker including history; empty Backspace returns to parent; per-view state preserved across switches.
  - Enter steers and Alt+Enter queues a follow-up, only while running; completed views are read-only. Child slash commands disabled except parent `/weave:inspect` and `/weave:clear-children`. Escape confirms subtree cancellation with child/tool/descendant details.
  - Local-only persisted private child Pi sessions plus a versioned index at `$XDG_DATA_HOME/weave/adapters/pi/child-history/<parent-session-id>/`, with restrictive permissions, branch-aware history, incremental checkpoints, quotas with visible trim markers, quarantine, orphan pruning, and physical clear of terminal history only.
  - Generic `settings.adapters.<harness>` opaque maps in core/config; Pi `child_inspection` settings validation with a single no-timeout popup on invalid input.
  - Recovery of interrupted ordinary top-level children; `/weave:recover-children`; workflow `/weave:resume` as a fresh attempt; bounded parent-context injection of recovered results.
  - Spec 33 amendments, ADR, guides, DSL docs, acceptance manifest, packed proof, autonomous live smoke.
- Out of scope:
  - Engine-owned child transcript persistence or `.weave/runtime` schema changes.
  - Public/headless Pi RPC; private RPC remains an internal adapter transport.
  - Exposing private child transcripts to the parent model, controller result, workflow completion, or any parent-visible context; only bounded terminal final output and existing numeric metadata cross that boundary.
  - Auto-recovery of nested descendants (they stay interrupted history) or of workflow child processes.
  - Keeping settled child processes alive, or weakening `forceKill()` / one-shot settlement.
  - Remote sync, network export, or telemetry of history data.
  - Pi fork changes or custom replacements for native Pi transcript components when they exist.
- Constraints / assumptions:
  - Bun only. `node:path` and `node:os` are allowed; Node filesystem/process/runtime APIs are not.
  - Every fallible internal API returns `Result`/`ResultAsync`; wrap Pi, Bun, FFI, renderer, and injected-port throws at the boundary with `neverthrow`.
  - Core owns opaque adapter-setting shape, depth/size bounds, and merge; Pi owns interpretation, UI, session paths, RPC, recovery.
  - Any `schema.ts` change updates `schema.test.ts`, `parser.test.ts`, `validate.test.ts`, and `parse_config.test.ts` in the same commit.
  - Tests use fake hosts, fake processes, fake clocks, in-memory ports, and isolated temp directories. No unit or integration test launches real Pi or touches real user data.
  - Live smoke runs autonomously via PTY in isolated `PI_CODING_AGENT_DIR`, `XDG_DATA_HOME`, and a disposable project; no human confirmation anywhere in this plan.

## Objectives

- Render and drive every private child with Pi-native visuals and interaction semantics while keeping the parent's global status to one line.
- Make intervention safe, scoped, counted, and text-free in everything the parent model or any durable sink can see.
- Keep private transcripts local to inspection/history and make the parent-result boundary explicit: return only bounded terminal final assistant output plus existing numeric metadata.
- Persist and recover private child sessions locally without crossing the Runtime Store, telemetry, or diagnostics boundary.
- Add harness-neutral opaque adapter settings validated by the owning adapter only.
- Produce complete automated, package, manifest, and autonomous live-smoke evidence bound to issue #21.

## Dependencies and Order

1. Freeze the normative contract, Spec 33 amendments, protocol/event schemas, and persistence format first: every later slice targets one accepted shape.
2. Add generic DSL adapter settings before Pi settings activation, because the adapter cannot validate data core drops.
3. Build the history store and its filesystem port before touching RPC/spawn lifecycle; build the transcript model and inspector on top of both.
4. Integrate delegation and direct dispatch only after the shared child-session service passes isolated tests.
5. Add recovery only after persistence, settlement, intervention counting, and controller integration are stable.
6. Update release evidence after focused and packed-package tests pass; run the digest-bound autonomous smoke last.

## Tasks

- [x] 1. Freeze the normative contract and amend Spec 33
  - **What**: Amend Spec 33 §11, §18, and §28 to supersede the ephemeral `--no-session`, transient-view, and blanket no-auto-resume rules for private children, while preserving §7 controller-generation staleness rules and one-shot settlement. Add a new normative section defining: view model and rendering fallback policy; interaction rules (Enter steer, Alt+Enter follow-up queue, running-only, read-only completed); slot/picker/navigation rules; disabled child slash commands with the two parent exceptions; Escape subtree-cancellation confirmation content; persistence location/permissions/format/state machine; quota, trim-marker, quarantine, orphan, and clear semantics; export contents (child index + bounded final output, never transcripts); recovery classes and limits; and the privacy exclusion list. Record #21 as the implementation issue.
  - **Files**: `docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md`, `docs/adr/0013-pi-private-child-sessions.md`, `docs/adapter-boundary.md`, `docs/README.md`, `docs/specs/README.md`
  - **Depends on**: None
  - **Acceptance**:
    - Every superseded rule is explicitly marked amended with its replacement, so no two sections conflict.
    - The spec fixes exact defaults, caps, key bindings, command names, failure codes, and privacy exclusions used by later tasks.
    - The adapter-boundary doc still assigns Pi UI, RPC, session discovery/I/O, and recovery to the adapter; no engine API scans the history root.
    - ADR 0013 records the decision to keep private child sessions adapter-owned and outside the Runtime Store, with consequences.
    - No task in the spec or plan requires human review, approval, or confirmation.

- [x] 2. Define protocol, event, and persistence schemas
  - **What**: Define the internal RPC/event schema for observed child state (message start/update/end, text, thinking, Markdown, tool call with arguments, tool partial result, tool result, tool error, image, usage, queue change, status, retry, notification/widget/dialog `extension_ui_request`) and the response envelope for `extension_ui_response`. Define `PiChildHistoryIndexV1` (record kind: ordinary | nested | workflow-step; status: running | queued | settled | interrupted | quarantined | cleared; parent/child topology; workflow/step breadcrumb; relative session path; active leaf + checkpoint cursor; branch ancestry; intervention count; bounded final output; trim/quarantine/clear/recovery metadata; byte accounting) and the on-disk layout, version field, and v0/missing/corrupt migration behavior. Encode all of it as Zod schemas with typed errors.
  - **Files**: `packages/adapters/pi/src/child-session-events.ts`, `packages/adapters/pi/src/child-history-schema.ts`, `packages/adapters/pi/src/__tests__/child-session-events.test.ts`, `packages/adapters/pi/src/__tests__/child-history-schema.test.ts`, `packages/adapters/pi/src/errors.ts`, `packages/adapters/pi/src/types.ts`
  - **Depends on**: Task 1
  - **Acceptance**:
    - Every event kind in Task 1 parses to a discriminated union variant; unknown kinds are preserved as a bounded `unknown` variant rather than thrown away or crashed on.
    - Index schema round-trips, rejects unknown versions, and caps every string field it stores.
    - Schemas assert that no raw transcript text is representable in exported/index-facing types except the single bounded final-output field.
    - Failure codes for schema, checkpoint, quarantine, recovery, and UI relay errors are added to the closed failure taxonomy and covered in `failure-taxonomy.test.ts`.

- [x] 3. Add generic opaque adapter settings to core and layered config
  - **What**: Add recursive JSON-like values, including literal `null`, through lexer/AST/parser/validate. Add `settings.adapters: Record<string, JsonValue>` with a 64 KiB UTF-8 canonical-JSON limit per adapter block and maximum nesting depth 4 beneath the block. Keep harness names opaque and Pi-free in core. Validate each source layer and the merged effective config so deep merge cannot exceed either bound. Preserve normal deep-merge, array union, scalar override, and null override semantics.
  - **Files**: `packages/core/src/lexer.ts`, `packages/core/src/ast.ts`, `packages/core/src/parser.ts`, `packages/core/src/validate.ts`, `packages/core/src/schema.ts`, `packages/core/src/index.ts`, `packages/core/src/__tests__/schema.test.ts`, `packages/core/src/__tests__/parser.test.ts`, `packages/core/src/__tests__/validate.test.ts`, `packages/core/src/__tests__/parse_config.test.ts`, `packages/config/src/merge.ts`, `packages/config/src/__tests__/merge.test.ts`
  - **Depends on**: Task 1
  - **Acceptance**:
    - Strings, finite interoperable numbers, booleans, null, arrays, and objects survive parse → validate → config unchanged under `settings.adapters.<harness>`.
    - Depth-5 values, non-JSON values, duplicate keys, and blocks over 64 KiB fail with precise `settings.adapters.<harness>.<path>` messages, aggregated rather than first-error-only.
    - Three-layer (builtin/global/project) tests prove ordinary deep merge plus post-merge size and depth validation, with no Pi-specific branch in core.
    - Schema, parser, validate, and full-pipeline tests each carry valid and invalid cases in the same commit.

- [x] 4. Validate Pi `child_inspection` settings and activation choices
  - **What**: Add a strict Pi-local Zod schema for `settings.adapters.pi.child_inspection` with defaults `persist_history=true`, `max_bytes_per_child=4194304`, `max_bytes_total=67108864`, `orphan_retention_days=30`, `recovery_enabled=true`, `recovery_countdown_seconds=10`. Reject unknown keys and out-of-range values, aggregating every issue. On each activation or reload with invalid settings, show exactly one no-timeout popup listing all issues with two choices: `Use defaults` or `Enter health-only mode`. Never loop, never partially apply invalid values, and never re-show within the same activation.
  - **Files**: `packages/adapters/pi/src/child-inspection-settings.ts`, `packages/adapters/pi/src/__tests__/child-inspection-settings.test.ts`, `packages/adapters/pi/src/config-activator.ts`, `packages/adapters/pi/src/safe-initializer.ts`, `packages/adapters/pi/src/extension.ts`, `packages/adapters/pi/src/types.ts`, `packages/adapters/pi/src/__tests__/config-activator.test.ts`, `packages/adapters/pi/src/__tests__/safe-initializer.test.ts`, `packages/adapters/pi/src/__tests__/extension.test.ts`, `packages/adapters/pi/src/__tests__/fakes/fake-pi-host.ts`
  - **Depends on**: Task 3
  - **Acceptance**:
    - Valid merged settings produce one immutable effective settings object shared by store, inspector, and recovery.
    - The popup has no timeout, lists every safe issue path/message exactly once, and applies defaults only after explicit selection.
    - Health-only selection performs no history writes, no child spawn, and no inspection activation.
    - Invalid Pi settings never invalidate unrelated `settings.adapters.<other>` blocks in core.
    - Reload after a fix clears the invalid state without restarting the host.

- [x] 5. Implement the private history filesystem port and store
  - **What**: Build an injected `PiChildHistoryStore` over a no-follow Bun/FFI filesystem port. Resolve the XDG root (`$XDG_DATA_HOME` overriding only the data-home prefix), sanitize/hash the parent session ID into one safe path component, create 0700 directories and 0600 files, and hold plus revalidate directory identity across writes. Implement atomic index and checkpoint writes, V1 migration, corrupt/unknown-version quarantine, per-child and total quotas, branch-preserving trim of oldest complete history with visible trim markers, orphan pruning after the retention grace, bounded index/final-output fields, and physical clear that deletes session bytes and index references for terminal records only.
  - **Files**: `packages/adapters/pi/src/child-history-fs.ts`, `packages/adapters/pi/src/child-history-store.ts`, `packages/adapters/pi/src/child-session-checkpoint.ts`, `packages/adapters/pi/src/__tests__/child-history-fs.test.ts`, `packages/adapters/pi/src/__tests__/child-history-store.test.ts`, `packages/adapters/pi/src/__tests__/child-session-checkpoint.test.ts`, `packages/adapters/pi/src/path-containment.ts`, `packages/adapters/pi/src/__tests__/path-containment.test.ts`, `packages/adapters/pi/src/index.ts`
  - **Depends on**: Tasks 2 and 4
  - **Acceptance**:
    - Default path is `~/.local/share/weave/adapters/pi/child-history/<parent-session-id>/`; `$XDG_DATA_HOME` changes only the prefix.
    - Symlinks, replaced directory/file identity, permissive modes, traversal, oversized records, malformed JSONL, and unsupported versions fail closed or quarantine without exposing raw content in the error.
    - Checkpoints append only unseen entries, persist the active leaf, restore alternate branches, and recover cleanly from a torn temp/index write.
    - No child exceeds `max_bytes_per_child` and no parent root exceeds `max_bytes_total` after enforcement; trimming preserves a valid active branch and writes a visible trim marker.
    - Trim protects the active view and the currently inspected view except when a single child exceeds its own per-child ceiling.
    - Clear physically removes terminal child session bytes and index references; running/queued children are refused. Orphan pruning removes only records older than `orphan_retention_days` that are not attached to the active parent session.

- [x] 6. Capture full RPC session state and preserve one-shot settlement
  - **What**: Split `PiRpcChild` into a process/settlement owner plus an injected session observer. Parse and forward every event kind from Task 2. Add typed `steer`, `follow_up`, `get_entries { since }`, and `extension_ui_response` methods guarded by generation, completed authenticated bootstrap, running state, and exact child identity. Spawn persisted children with a private `--session-dir`; restore with the exact `--session` plus active branch/checkpoint context. Preserve force-kill, cancellation races, one pending settlement, and late/duplicate reply handling. Use three separate limits: 8 MiB native Pi JSONL records, 64 KiB signed control bodies, and 64 MiB logical chunked transfers. Every prompt and output transfer receives an authenticated ACK/NACK, waits 10 seconds, and retries once. Stdin writes await flush and preserve every partial-write suffix. Completed settlement fields are `assistantOutput`, `completionCandidate`, optional `outputTransferId`, and numeric `outputByteLength`; direct-step candidates are never stored in prose. Full output travels privately to inspection/history, while controller and workflow results receive only the 4 KiB projection plus numeric metadata. A failed output transfer degrades to bounded inline settlement rather than no settlement.
  - **Files**: `packages/adapters/pi/src/rpc-child.ts`, `packages/adapters/pi/src/child-process-port.ts`, `packages/adapters/pi/src/child-framing.ts`, `packages/adapters/pi/src/child-envelope.ts`, `packages/adapters/pi/src/__tests__/rpc-child.test.ts`, `packages/adapters/pi/src/__tests__/child-process-port.test.ts`, `packages/adapters/pi/src/__tests__/child-framing.test.ts`, `packages/adapters/pi/src/__tests__/child-envelope.test.ts`
  - **Depends on**: Task 5
  - **Acceptance**:
    - Tests cover split/multiple records, out-of-order updates, every supported event kind, and a valid native Pi RPC assistant record larger than 1 MiB; the oversized record is handled within the separate native-record bound, does not poison transport, does not produce `ChildSettlementMissing`, and sends no raw payload to logs.
    - A native record beyond the native-record bound fails with a typed bounded failure without weakening the strict 64 KiB private control-envelope cap or poisoning unrelated settlement state.
    - `steer` and `follow_up` emit only for an authenticated running child; idle, queued, completed, and interrupted children reject with typed safe failures.
    - Each intervention increments a counter only after RPC acceptance; its text exists only inside the private session file.
    - Settlement still resolves exactly once and force-kills plus erases transport secrets even while a completed view remains open from history; valid output of any transfer-supported size cannot cause `ChildSettlementMissing`. Delivery timeout, rejection, oversize, and write failure use their exact typed transfer codes.
    - The parent-facing settlement contains only bounded final output from the terminal assistant response plus existing numeric metadata; intermediate assistant messages, thinking, tool calls/results, transcript entries, and extension UI events remain available only to local inspection/history.
    - Spawn/restore arguments reference only the allocated private history path and never accept child-controlled paths.

- [x] 7. Build the Pi-native transcript renderer, fallbacks, and extension-UI bridge
  - **What**: Build a component-based transcript view using Pi's exported assistant/tool/Markdown/image/usage/queue/status components, theme and width helpers, when probed available; otherwise render Pi-styled fallbacks with identical information. Use Pi tool definitions for known tools and the generic tool component for unknown custom tools. Mirror blocking and fire-and-forget `extension_ui_request` variants (notifications, widgets, dialogs) into the selected child view and send correlated `extension_ui_response` only to the originating authenticated child. Add the breadcrumb/title (`parent › … › child`, plus workflow and step), the one-line global status, trim/recovery/interruption markers, sanitized width-bounded task previews, and component cache invalidation.
  - **Files**: `packages/adapters/pi/src/child-transcript.ts`, `packages/adapters/pi/src/child-inspection-render.ts`, `packages/adapters/pi/src/child-extension-ui.ts`, `packages/adapters/pi/src/__tests__/child-transcript.test.ts`, `packages/adapters/pi/src/__tests__/child-inspection-render.test.ts`, `packages/adapters/pi/src/__tests__/child-extension-ui.test.ts`, `packages/adapters/pi/src/child-tree-render.ts`, `packages/adapters/pi/src/__tests__/child-tree-render.test.ts`
  - **Depends on**: Task 6
  - **Acceptance**:
    - Golden tests cover task and user-steering entries, thinking, Markdown, streaming assistant updates, known and unknown tools with arguments, partial/error/image results, usage, queues, and narrow terminal widths.
    - The same golden expectations run against both native-component and fallback host fixtures, differing only in component provenance, never in shown information.
    - Unknown tools and unknown event variants render safely without throwing or dropping their bounded result.
    - Dialogs, notifications, widgets, status, title, and editor text stay scoped to the child; stale or cross-child responses are rejected, and extension UI events never cross the parent-result boundary.
    - Native Pi output over 1 MiB remains inspectable through private history while only the bounded terminal final assistant output is eligible for parent results.
    - Breadcrumbs show workflow and step for direct dispatch; the global status stays one line and contains no raw task text.

- [x] 8. Implement slots, picker, navigation, and per-view editor state
  - **What**: Add a `PiChildInspector` state machine plus a compositional editor wrapper. Allocate stable Alt+1..9 slots to live non-queued children only, holding each slot until that child leaves the live set; never assign slots to queued or completed children. Open the hierarchy picker on Alt+I and `/weave:inspect`, including history records with sanitized previews and recovery/resume actions. Empty Backspace returns to the parent view; non-empty Backspace edits the draft. Enter sends steer and Alt+Enter queues a follow-up, only while running; completed views are read-only. Intercept child slash input: allow only parent `/weave:inspect` and `/weave:clear-children`, rejecting every other slash command without relaying it. Escape opens a no-timeout subtree-cancellation confirmation naming the child, its current tool, and its descendants. Preserve draft text, scroll offset, tool expansion, thinking visibility, and image/queue state per view across switches.
  - **Files**: `packages/adapters/pi/src/child-inspector.ts`, `packages/adapters/pi/src/child-picker.ts`, `packages/adapters/pi/src/child-inspection-editor.ts`, `packages/adapters/pi/src/child-tree-keys.ts`, `packages/adapters/pi/src/__tests__/child-inspector.test.ts`, `packages/adapters/pi/src/__tests__/child-picker.test.ts`, `packages/adapters/pi/src/__tests__/child-inspection-editor.test.ts`, `packages/adapters/pi/src/__tests__/child-tree-keys.test.ts`
  - **Depends on**: Task 7
  - **Acceptance**:
    - Slots stay stable while a child runs, release on terminal transition, skip queued children, and never select completed records; completed records stay picker-accessible.
    - Picker tests cover root/ordinary/nested/workflow hierarchy, history entries, sanitized previews, recovery and resume actions, and empty-Backspace parent navigation.
    - Enter/Alt+Enter are impossible outside `running`; rejected slash commands, idle Enter, and stale-view keys never reach RPC.
    - Switching among parent and child views restores each view's exact draft, scroll, expansion, thinking, and image/queue state.
    - Escape cancellation shows child/tool/descendant details, affects only the confirmed subtree, and preserves root Escape behavior when no child view is active.

- [x] 9. Integrate every child creation path into one inspection/history registry
  - **What**: Inject the history/inspector registry into `PiDelegationController` for ordinary and nested children and into the direct-dispatch transport/registry for workflow-step children. Register topology before spawn, checkpoint during events, mark interruption before shutdown cleanup, and retain terminal records after process disposal. Keep direct-step completion authority, budget exemption, and nested relay rules unchanged. Populate workflow/step breadcrumbs only from trusted controller state, never from child payloads.
  - **Files**: `packages/adapters/pi/src/delegation-controller.ts`, `packages/adapters/pi/src/direct-dispatch-transport.ts`, `packages/adapters/pi/src/direct-dispatch.ts`, `packages/adapters/pi/src/controller.ts`, `packages/adapters/pi/src/child-tree.ts`, `packages/adapters/pi/src/extension.ts`, `packages/adapters/pi/src/__tests__/delegation-controller.test.ts`, `packages/adapters/pi/src/__tests__/direct-dispatch-transport.test.ts`, `packages/adapters/pi/src/__tests__/direct-dispatch.test.ts`, `packages/adapters/pi/src/__tests__/controller.test.ts`, `packages/adapters/pi/src/__tests__/child-tree.test.ts`, `packages/adapters/pi/src/__tests__/extension.test.ts`
  - **Depends on**: Tasks 6–8
  - **Acceptance**:
    - Ordinary, nested, and workflow-step children appear in one hierarchy and use the same renderer and history contract.
    - Direct dispatch stays outside ordinary delegation budgets and keeps authenticating bootstrap with the generated `childId`, not engine correlation.
    - Settled children release capacity and processes while retaining picker/history records; parallel capacity is never consumed by settled children.
    - Shutdown marks eligible children interrupted before force-kill and never resumes work in the old generation.

- [x] 10. Add ordinary-child recovery and keep workflow resume separate
  - **What**: Discover recovery candidates from the active parent-session index. For interrupted ordinary top-level children only, show one popup with `Recover now` / `Skip` / `Inspect` and a `recovery_countdown_seconds` countdown whose expiry recovers. Recovery resolves the current trusted descriptor by stable name, applies the current trusted model/policy/limits, starts a newly authenticated process against the stored session and active branch, and appends a visible fixed continuation message. `Skip`/`Inspect` leave the child recoverable via the picker or `/weave:recover-children`. Nested descendants stay interrupted history. Workflow records expose `/weave:resume`, which creates a fresh authorized attempt and keeps the old history linked. When a recovered result settles with no live waiter, extract at most 4 KiB from the terminal assistant response only, store it, and add that bounded final output plus the intervention count (never transcript, intermediate assistant messages, thinking, tool calls/results, extension UI events, or intervention text) to parent model context without triggering a turn.
  - **Files**: `packages/adapters/pi/src/child-recovery.ts`, `packages/adapters/pi/src/__tests__/child-recovery.test.ts`, `packages/adapters/pi/src/commands.ts`, `packages/adapters/pi/src/workflow-commands.ts`, `packages/adapters/pi/src/recovery-pointer.ts`, `packages/adapters/pi/src/extension.ts`, `packages/adapters/pi/src/__tests__/workflow-commands.test.ts`, `packages/adapters/pi/src/__tests__/recovery-pointer.test.ts`, `packages/adapters/pi/src/__tests__/fakes/fake-pi-host.ts`
  - **Depends on**: Task 9
  - **Acceptance**:
    - Only interrupted ordinary children whose parent is the root are auto-recovery candidates; nested and workflow children never auto-recover.
    - Countdown expiry, immediate recovery, skip, inspect, later picker recovery, and `/weave:recover-children` are deterministic under a fake clock.
    - Descriptor removal/change, untrusted project state, stale generation, missing or quarantined history, and `recovery_enabled=false` fail closed with one safe message and no spawn.
    - The resumed child carries a visible fixed continuation message and runs under current trusted descriptor/model/policy/limits, not stored ones.
    - `/weave:resume` starts a new workflow attempt linked in history and never reuses the old process or session as execution authority.
    - A recovered result with no live waiter injects at most 4 KiB final output plus intervention count into parent context, generates no turn, and includes no intervention text.

- [x] 11. Project bounded results, intervention counts, and exports
  - **What**: Extend ordinary and workflow child result models so the parent receives bounded final output plus existing numeric metadata, including the numeric intervention count. Extract final output only from the terminal assistant response; do not concatenate or select intermediate assistant messages, thinking, tool calls/results, or transcript entries. Keep structured workflow completion as the single authority. Make exports carry the child index and bounded final output only, never transcripts. Ensure late interventions cannot mutate an already-settled result and that intervention text never enters tool results, completion candidates, Runtime Store inputs, recovery pointers, logs, failures, telemetry, diagnostics, or index previews.
  - **Files**: `packages/adapters/pi/src/child-control-bodies.ts`, `packages/adapters/pi/src/child-runtime.ts`, `packages/adapters/pi/src/delegation-tool.ts`, `packages/adapters/pi/src/structured-completion.ts`, `packages/adapters/pi/src/workflow-controller.ts`, `packages/adapters/pi/src/artifact-provider.ts`, `packages/adapters/pi/src/__tests__/child-control-bodies.test.ts`, `packages/adapters/pi/src/__tests__/child-runtime.test.ts`, `packages/adapters/pi/src/__tests__/delegation-tool.test.ts`, `packages/adapters/pi/src/__tests__/structured-completion.test.ts`, `packages/adapters/pi/src/__tests__/workflow-controller.test.ts`, `packages/adapters/pi/src/__tests__/artifact-provider.test.ts`
  - **Depends on**: Tasks 6 and 10
  - **Acceptance**:
    - Parent-visible ordinary results and recovered context messages contain only bounded terminal `finalOutput` plus `interventionCount` and existing numeric workflow metadata.
    - Final-output extraction ignores intermediate assistant messages and takes the bounded content of the terminal assistant response only; absent or non-terminal assistant content does not fall back to transcript concatenation.
    - Workflow completion still flows through one structured candidate plus `agent_settled`; interventions grant no completion authority.
    - Export fixtures contain the child index and bounded terminal final output and no transcript entries, thinking, tool calls/results, or extension UI events.
    - Privacy tests seed unique intervention text and prove it appears only in the private session fixture.
    - Oversized native-output tests prove a valid >1 MiB assistant RPC record settles without transport poisoning or `ChildSettlementMissing`, remains available to the local inspector/history, and exposes only terminal bounded output plus numeric metadata to the parent.

- [x] 12. Register commands, keys, probes, and package exports
  - **What**: Add `/weave:inspect`, `/weave:clear-children`, and `/weave:recover-children` to the closed direct-command set, palette, provenance/collision checks, and generation gates, alongside the existing `/weave:resume`. Bind Alt+I and Alt+1..9 through the compositional editor rather than global shortcuts. Extend required host probes for exported transcript components, editor composition, RPC steering/follow-up, entry checkpoints, session restore, and extension UI response, with declared fallbacks where the contract allows them and health-only mode where it does not. Export only testable services and types; never secrets or raw-history internals.
  - **Files**: `packages/adapters/pi/src/commands.ts`, `packages/adapters/pi/src/host-inventory.ts`, `packages/adapters/pi/src/capability-prober.ts`, `packages/adapters/pi/src/capability-declarations.ts`, `packages/adapters/pi/src/host-compatibility-matrix.ts`, `packages/adapters/pi/src/safe-initializer.ts`, `packages/adapters/pi/src/index.ts`, `packages/adapters/pi/src/__tests__/host-inventory.test.ts`, `packages/adapters/pi/src/__tests__/capability-prober.test.ts`, `packages/adapters/pi/src/__tests__/host-compatibility-matrix.test.ts`, `packages/adapters/pi/src/__tests__/safe-initializer-no-write.test.ts`, `packages/adapters/pi/src/__tests__/safe-initializer.test.ts`, `packages/adapters/pi/src/__tests__/package-consumption.test.ts`
  - **Depends on**: Tasks 8–11
  - **Acceptance**:
    - Command names are exact, collision-probed, generation-checked, and asserted in fake-host and package-consumption tests.
    - Safe initialization stays read-only and emits one result per declared probe even when a host surface is missing.
    - Missing rendering surfaces select declared Pi-style fallbacks; missing RPC/session surfaces enter health-only mode rather than degrading privacy or recovery silently.

- [x] 13. Prove privacy, quotas, migration, and failure behavior end to end
  - **What**: Add an isolated adapter integration suite driving fake RPC children through nested delegation, workflow dispatch, steering, queued follow-ups, extension UI, interruption, restart, recovery, resume, trim, quarantine, clear, and retention. Include a reproduced native Pi assistant RPC record larger than 1 MiB and assert separate bounded handling against the strict private control-envelope cap. Seed canary values in prompts, task text, intervention text, tool arguments, images, RPC bodies, paths, and secrets, then scan every forbidden sink and every generated proof fixture. Assert backward compatibility: a config without `settings.adapters`, an absent history root, and a v0/missing index all behave correctly.
  - **Files**: `packages/adapters/pi/src/__tests__/child-inspection-integration.test.ts`, `packages/adapters/pi/src/__tests__/child-inspection-privacy.test.ts`, `packages/adapters/pi/src/__tests__/child-inspection-migration.test.ts`, `packages/adapters/pi/src/__tests__/telemetry.test.ts`, `packages/adapters/pi/src/__tests__/runtime-store-port.test.ts`, `packages/adapters/pi/src/__tests__/failure-taxonomy.test.ts`, `scripts/release/__tests__/pi-adapter-fake-host-consumer.test.ts`
  - **Depends on**: Tasks 5–12
  - **Acceptance**:
    - Canary scans prove raw history and intervention text are absent from Runtime Store, journal, logs, usage, health, failures, recovery pointers, telemetry, diagnostics, manifest, and proof artifacts; parent-facing results contain only bounded terminal final output plus existing numeric metadata.
    - Quota, trim-marker, branch restore, migration, quarantine, physical clear, and orphan retention paths pass under fake clocks and isolated filesystems.
    - A valid native Pi record larger than 1 MiB is handled within its separate native-record bound, does not poison transport or produce `ChildSettlementMissing`, and does not weaken the strict private control-envelope cap.
    - Cancellation and force-kill tests still cover stopped and non-cooperative children with exact subtree selection.
    - Legacy configs and missing/old history directories produce working ephemeral behavior with no error and no data loss.

- [x] 14. Update DSL, architecture, adapter, and package documentation
  - **What**: Document generic `settings.adapters.<harness>` semantics and bounds, exact Pi `child_inspection` defaults, inspector controls and key bindings, command list, session location/permissions, quotas and trim markers, clear/recovery/resume behavior, export contents, the privacy boundary, and troubleshooting. Update the published DSL reference site page and the Pi package README. Cross-link Spec 33 and ADR 0013.
  - **Files**: `docs/dsl-reference.md`, `docs/config-loading.md`, `docs/adapters/pi.md`, `docs/pi-adapter.md`, `docs/adapter-readiness-status.md`, `packages/adapters/pi/README.md`, `packages/docs/src/content/docs/docs/reference/dsl/index.mdx`
  - **Depends on**: Tasks 3–13
  - **Acceptance**:
    - Every new key, command, key binding, default, path, cap, retention rule, and recovery limitation appears once in its canonical source and is cross-linked elsewhere.
    - Docs state that private sessions may contain sensitive raw content and explain physical clear and local-only storage.
    - Docs never claim nested auto-recovery, workflow process recovery, exported transcripts, or engine ownership of history.
    - `docs/README.md` and `docs/specs/README.md` link the new ADR and amended spec.

- [x] 15. Extend acceptance manifest, packed proof, and autonomous live smoke
  - **What**: Add stable requirement IDs and rows for inspection rendering and fallbacks, interaction controls, private persistence and privacy, the parent-result boundary, oversized native Pi output handling, quotas/clear, settings validation, and recovery/resume. Update manifest schema, builder, data, and tests, plus the packed-proof registry and generated manifest. Replace obsolete `--no-session` and "not steerable" smoke rows. Increment the checklist version and add autonomous PTY smoke steps covering all three child kinds, slots and picker, native and fallback rendering, steer and queued follow-up counts, extension UI relay, read-only completed views, interruption and recovery, workflow fresh resume, quota trim and clear, the invalid-settings popup with both choices, a valid >1 MiB native assistant record, terminal-only parent output extraction, and forbidden-sink scans. Add a settlement-error validator that repeats the oversized-output scenario, inspects every structured parent-visible delegation, direct-dispatch, and workflow result or error, and fails immediately if any result has the exact `ChildSettlementMissing` error discriminator. Do not rely on log-text grep alone. Bind results to the exact package digest, subject SHA, host version, and run attempt.
  - **Files**: `scripts/release/acceptance-manifest.ts`, `scripts/release/acceptance-manifest-data.ts`, `scripts/release/smoke-checklist.ts`, `scripts/release/pi-child-inspection-smoke.ts`, `scripts/release/__tests__/acceptance-manifest.test.ts`, `scripts/release/__tests__/generate-acceptance-manifest.test.ts`, `scripts/release/__tests__/pi-child-inspection-smoke.test.ts`, `docs/specs/33-spec-pi-adapter/acceptance-manifest.schema.json`, `docs/specs/33-spec-pi-adapter/acceptance-manifest.json`, `docs/specs/33-spec-pi-adapter/33-smoke-checklist.md`, `docs/specs/33-spec-pi-adapter/33-proofs/33-child-inspection-proofs.md`
  - **Depends on**: Tasks 12–14
  - **Acceptance**:
    - Every new requirement cites existing named tests, packed proof IDs, and smoke IDs; the verifier reports no missing and no orphan evidence, including parent-result-boundary and oversized-native-output rows.
    - The PTY driver runs with zero human input in disposable `XDG_DATA_HOME`, `PI_CODING_AGENT_DIR`, and project roots, storing only sanitized assertions and screenshots; its parent-result assertions prove that only bounded terminal final output and numeric metadata cross the boundary.
    - The digest-bound smoke runs the valid >1 MiB output case at least 10 times sequentially and once at configured maximum child parallelism. Every run returns its unique terminal sentinel, every structured result/error is checked, and the report records `childSettlementMissingCount: 0`; any `ChildSettlementMissing` discriminator fails the smoke.
    - Unit tests prove the validator rejects a structured `ChildSettlementMissing` result even when logs contain no matching text, so the check cannot silently degrade into grep-only validation.
    - The manifest is regenerated from source, stays pending until the digest-bound smoke passes, then records exactly one artifact binding.
    - Proof artifacts land under `33-proofs/` per `docs/documentation-policy.md`, not beside durable guides.

- [ ] 16. Verify, partition, and prepare focused commits
  - **What**: Run focused tests per phase, then the full Bun suite, typecheck, build, package policy, fake consumer, manifest verification, and the autonomous live smoke. Diff the final path-scoped worktree against the baseline captured before Task 1 and delete only feature-created temp data. Prepare small Conventional Commits without staging unrelated dirty hunks.
  - **Depends on**: Task 15
  - **Acceptance**:
    - `bun test packages/core/src/__tests__ packages/config/src/__tests__` passes.
    - `bun test packages/adapters/pi/src` passes with no real Pi process and no writes outside temp directories.
    - `bun run typecheck`, `bun test`, and `bun run build` pass.
    - Release, manifest, and package tests pass, and the digest-bound smoke passes against the final tarball.
    - Commits are sliced as: `docs(pi): amend spec 33 for child inspection`, `feat(core): add opaque adapter settings`, `feat(pi): validate child inspection settings`, `feat(pi): persist private child sessions`, `feat(pi): capture full child rpc state`, `feat(pi): render native child transcripts`, `feat(pi): add child inspector navigation`, `feat(pi): recover interrupted children`, `test(pi): prove child inspection privacy`, `docs(pi): document child inspection`, `docs(pi): publish child inspection evidence`.
    - Release evidence includes the >1 MiB native-output regression, proves valid oversized records do not poison transport or produce `ChildSettlementMissing`, and proves parent results contain only bounded terminal assistant output plus existing numeric metadata.
    - No unrelated existing edit is staged, reverted, reformatted, or included in any commit, verified against the baseline diff.

## Verification

Run in this order so failures stay attributable:

```bash
bun test packages/core/src/__tests__/schema.test.ts \
  packages/core/src/__tests__/parser.test.ts \
  packages/core/src/__tests__/validate.test.ts \
  packages/core/src/__tests__/parse_config.test.ts \
  packages/config/src/__tests__/merge.test.ts

bun test packages/adapters/pi/src
# Includes the >1 MiB native-RPC regression and terminal-assistant-only parent-result tests.
bun run typecheck
bun test
bun run build
bun test scripts/release/__tests__
```

Then pack the adapter, compute its SHA-256, install it into isolated Pi/XDG directories, and run the autonomous PTY smoke:

```bash
bun run scripts/release/pi-child-inspection-smoke.ts \
  --artifact <final-tarball> \
  --repeat-oversized-settlement 10
```

Passing means: all focused and full tests exit zero; typecheck and build succeed; the oversized-native-output regression proves that a valid >1 MiB native Pi record does not poison transport or produce `ChildSettlementMissing`; the structured settlement-error validator observes every repeated sequential and maximum-parallelism result, returns each unique terminal sentinel, records `childSettlementMissingCount: 0`, and fails on any exact `ChildSettlementMissing` discriminator; terminal-only extraction tests prove that the parent receives only bounded final assistant output plus existing numeric metadata; manifest verification reports no missing or orphan evidence; the smoke report binds one subject SHA, package digest, host version, and run attempt with every inspection, interaction, persistence, settings, recovery, clear, parent-boundary, and oversized-output row passing; and canary scans find raw child data only inside the restrictive private history fixture. Finally, compare `git status --short` and path-scoped diffs against the pre-work baseline to prove unrelated dirty edits are intact.
