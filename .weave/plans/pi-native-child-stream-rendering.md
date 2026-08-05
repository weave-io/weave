# Pi Native Child Stream Rendering

## TL;DR
Replace the Pi adapter's JSONL child-history store with persistent native Pi v3 child sessions, a compact native-style `weave_delegate` activity block, a full-screen focused child overlay, thread-lifecycle `weave_delegate` extensions (start/retry/continue), a rebuildable metadata-only SQLite cache, and bounded history/doctor surfaces — all behind capability probes, with real-harness proof on Pi 0.83.

## Context
The design is confirmed and settled; this plan sequences implementation only. Do not use `.weave/plans/weave-pi-child-inspection.md`; it is stale and conflicting.

Current state (verified at HEAD `c870c2f`, heavily dirty worktree):

- The Pi adapter (`packages/adapters/pi/src/`) has a JSONL-era private child-history stack: `child-history-fs.ts`, `child-history-schema.ts`, `child-history-store.ts`, `child-inspection-settings.ts` (store quotas/retention settings), `recovery-pointer.ts`, `child-session-checkpoint.ts`, plus transcript/inspection modules `child-transcript.ts`, `child-tree.ts`, `child-tree-render.ts`, `child-tree-keys.ts`, `child-inspection-custom.ts`, `child-inspection-editor.ts`, `child-inspection-render.ts`, `child-inspector.ts`, `child-picker.ts`, `child-native-components.ts`. JSONL references also appear in `delegation-controller.ts`, `extension.ts` (wires `childHistoryStoreFactory` around lines 548/657/3809), `errors.ts`, `rpc-child.ts`, `child-framing.ts`.
- ADR `docs/adr/0013-pi-private-child-sessions.md` (Accepted) normatively describes the old `child-history/<parent-session-id>/` V1 index/checkpoint layout, referenced by Spec 33 (`docs/specs/33-spec-pi-adapter/`), `docs/adapters/pi.md`, `docs/architecture/adapter-boundary.md`, `docs/reference/dsl.md`, `docs/reference/configuration.md`.
- `extension.ts` (~177 KB) already routes `weave:health` and `weave:inspect` (`commands.ts`), and wires Alt+1..9 child selection and an Alt+T overlay through an opaque `(tui, theme, keybindings)` port. `/weave:history` and `/weave:doctor` do not exist.
- Compatibility floor: `host-compatibility-matrix.ts` (`HOST_VERSION_FLOOR`, `exactTestedVersion: "0.81.1"`), `capability-declarations.ts`, `capability-prober.ts`.
- Security primitives exist: `path-containment.ts` (28 KB), `port-safety.ts`, `strict-json.ts`, `child-crypto.ts`, `child-envelope.ts`.
- CLI pattern for bounded commands: `packages/cli/src/commands/runtime.ts` (`runRuntime`). No `weave adapter` command group exists.
- Engine boundary: `packages/engine/src/adapter.ts`, `capability-contract.ts`, `runtime-command-operations/`. The engine must never parse Pi output or own Pi session concepts (`docs/architecture/adapter-boundary.md`).
- The repo is health-only mode; this work carries a narrow, explicit exception.

Conventions: Bun only, `neverthrow` `Result`/`ResultAsync` everywhere, no `console.*`, schema+test+doc in the same commit, mocks for boundary tests, real-harness proof per `docs/testing/adapter-verification.md`, Conventional Commits, issue-linked PR.

Dirty-worktree rule: many files are dirty for unrelated in-flight work (OpenCode adapter, builtin prompts, core schema, CLI migration, ADR 0001/0003, product-vision). Commit only files this plan names, stage hunks deliberately, and never revert or reformat unrelated dirty edits.

## Scope
- In scope:
  - Native Pi v3 persistent child sessions under `$XDG_DATA_HOME/weave/adapters/pi/sessions/` with `parentSession` links, tombstones, and explicit cleanup.
  - Parent custom-entry child refs (validated, bounded, origin-immutable) as observations, never recovery authority.
  - Rebuildable metadata-only SQLite discovery cache (no transcripts, no parent content).
  - Compact `weave_delegate` tool-block rendering (latest meaningful fragment, native style, 3-line collapsed tail) and final assembled response tail/error on settlement.
  - Full-screen focused overlay: complete native-style child transcript (live and historical), picker, keys, steering, follow-up, cancel-subtree confirmation, renderer fallback.
  - `weave_delegate` thread lifecycle: start / retry (retryable failed or cancelled) / continue (completed, requires task), opaque thread IDs, run dividers, capacity semantics, policy revalidation.
  - `ChildResponseMissing` result contract (parent-observed non-whitespace terminal assistant response).
  - Session-transition pre-hooks (new/resume/fork/clone/branch/tree), quit/reload bounded cancel, orphan read-only history, fork/clone ref-origin rejection.
  - `PersistentParentSessionRequired` handling for `--no-session` parents.
  - Generic adapter-command dispatch boundary (engine), `/weave:history`, `/weave:doctor`, `weave adapter pi children list/show/delete` + `doctor` CLI.
  - Capability probes (persistent RPC session/restore, appendEntry, get_entries/get_tree, custom session dir), Pi >= 0.81.1 floor, health-only and overlay-gap fallbacks.
  - Removal of the JSONL child-history store and its settings.
  - Threat model, diagnostics with stable codes, docs/ADR/spec updates, Weft + mandatory Warp gates, Pi 0.83 Herdr real-harness proof.
- Out of scope:
  - Any legacy JSONL-history migration (explicit no-migration decision; document it).
  - Automatic pruning, duplicate transcript store, adapter transcript DB.
  - Manual native Pi CLI access to child sessions; child sessions in `/resume`.
  - Feature work outside this design; editing `.weave/plans/weave-pi-child-inspection.md`.
  - Moving any Pi parsing or session concept into engine/core.
- Constraints / assumptions:
  - Health-only mode exception applies only to this plan's work.
  - No experimental dual path: complete behavior is exposed only after full acceptance; stage commits so partial states stay inert (capability-gated, not user-reachable).
  - XDG root fixed; local locale for UI dates, ISO for details; compact block fixed at 3 lines.
  - Keybindings are named configurable Pi actions; conflicts are reported, never overwritten.

## Objectives
- Child transcripts live only in native Pi v3 sessions, isolated from Pi's default session tree.
- Parents observe children through bounded custom-entry refs and a rebuildable metadata cache; source entries are authoritative, cache degrades without blocking execution.
- Users inspect any child (live, historical, nested) through one native-feeling overlay with full navigation, steering, and follow-up.
- `weave_delegate` gains thread retry/continue with strict ownership, capacity, and integrity semantics.
- All new surfaces are capability-probed, diagnosable, documented, tested at every layer, and proven on a real Pi 0.83 harness.

## Dependencies and Order
1. Stage 0 — Decisions and contracts first (Tasks 1–3): superseding ADR, Spec 33 rewrite, threat model, capability probes. Everything downstream cites these contracts; writing code before the ADR/spec invites drift and Warp rejection.
2. Stage 1 — Storage and authority substrate (Tasks 4–7): native child session manager, parent custom-entry refs, metadata cache, persistent-parent requirement. The delegation lifecycle and every UI/CLI surface read through these modules.
3. Stage 2 — Execution semantics (Tasks 8–10): result contract (`ChildResponseMissing`), thread lifecycle (start/retry/continue), session-transition hooks. These depend on Stage 1 identity/refs and must land before rendering because renderers key off run/thread/settlement events.
4. Stage 3 — Rendering and interaction (Tasks 11–14): compact block, overlay, picker + keys, commands + engine dispatch boundary + CLI. Depends on Stages 1–2 event and metadata shapes.
5. Stage 4 — Diagnostics and removal (Tasks 15–16): doctor/diagnostics, then JSONL store removal. Removal comes after replacement paths exist so no commit leaves the adapter without a child-history mechanism.
6. Stage 5 — Verification and delivery (Tasks 17–21): cross-cutting test suites, docs, Weft gate, real-harness proof, Warp gate, PR. Real-harness proof requires the full feature assembled; gates are last.

## Tasks

- [x] 1. Write superseding ADR and no-migration decision
  - **What**: Add ADR 0014 "Pi native child sessions" superseding the storage/layout portions of ADR 0013: native Pi v3 child sessions under `$XDG_DATA_HOME/weave/adapters/pi/sessions/` (outside Pi's default tree, never in `/resume`), child `parentSession` link, parent custom-entry refs as observation-only, metadata-only rebuildable SQLite cache, explicit-cleanup-plus-tombstone, no auto pruning, explicit no-migration from the JSONL V1 store, `PersistentParentSessionRequired`, and fork/clone ref-origin rejection. Mark ADR 0013 as superseded-in-part with a pointer.
  - **Files**: `docs/adr/0014-pi-native-child-sessions.md` (new), `docs/adr/0013-pi-private-child-sessions.md` (status header edit only).
  - **Depends on**: None.
  - **Implementation outline**:
    1. Draft ADR 0014 with Context/Decision/Consequences covering every settled point above, including the authority chain: parent entries + child session files authoritative; cache derivative; custom refs never recovery authority.
    2. Record the no-migration decision and its consequence: existing JSONL history becomes unreadable by Weave and is not deleted by Weave.
    3. Amend ADR 0013's status line and add a "Superseded by ADR 0014 for storage, layout, migration, quotas, and pruning" note without rewriting its history.
  - **Pitfalls / non-goals**:
    - Do not delete ADR 0013 or rewrite its Decision text; ADRs are append-only history.
    - Do not restate UI details in the ADR; those belong in Spec 33.
  - **Acceptance**:
    - ADR 0014 exists, is internally consistent with the confirmed design, and links ADR 0013, Spec 33, `docs/adapters/pi.md`, `docs/architecture/adapter-boundary.md`.
    - `bun run docs:check-links` passes.

- [x] 2. Rewrite Spec 33 sections and add the security threat model
  - **What**: Update `docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md` normative sections to the new contract (session layout, refs, cache, compact block, overlay, keys, picker, thread lifecycle, result contract, transitions, diagnostics codes, CLI, capability probes), and add a threat-model document covering path/session authority.
  - **Files**: `docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md`, `docs/specs/33-spec-pi-adapter/33-threat-model.md` (new), `docs/specs/33-spec-pi-adapter/33-smoke-checklist.md`.
  - **Depends on**: Task 1.
  - **Implementation outline**:
    1. Replace V1 index/checkpoint normative text with the native-session contract; enumerate stable diagnostic codes (including `PersistentParentSessionRequired`, `ChildResponseMissing`, integrity/stale/already-running codes) and the bounded ref schema fields (opaque child/thread ID, native session ID, root-relative ref, immutable originating parent session + entry IDs, title/status/times/runs).
    2. Write the threat model: spoofed/forged custom refs, fork/clone-copied refs (origin mismatch ⇒ ignored, no authority), path traversal/symlink escape from the XDG root, cache poisoning (cache is non-authoritative; rebuild path), terminal control-sequence injection from child output, parent-context leakage limits (no child content beyond bounded `weave_delegate` result), session-file permission requirements (user-only), and no raw prompt/transcript in diagnostics.
    3. Update the smoke checklist to the new acceptance surfaces (compact, overlay, picker, retry/continue, history/doctor, transitions).
  - **Pitfalls / non-goals**:
    - Spec 33's `acceptance-manifest.json` regeneration, if required by tooling, is handled in Task 18 with the proofs — do not hand-edit proofs here.
    - Keep the engine boundary language: no Pi session concepts in engine/core.
  - **Acceptance**:
    - Spec text matches the confirmed design with no residual V1-index normative language.
    - Threat model enumerates each listed threat with its mitigation and the module that owns it.
    - `bun run docs:check-links` passes.

- [x] 3. Extend capability declarations, probes, and compatibility floor
  - **What**: Add mandatory probes for persistent RPC session/restore, `appendEntry`, `get_entries`/`get_tree`, and custom session directory support; keep floor Pi >= 0.81.1 with no maximum; missing required session capability ⇒ health-only with named capability, host version, contract, probe result, mode, and remediation; overlay-only gap ⇒ existing custom-editor fallback.
  - **Files**: `packages/adapters/pi/src/capability-declarations.ts`, `packages/adapters/pi/src/capability-prober.ts`, `packages/adapters/pi/src/host-compatibility-matrix.ts`, `packages/adapters/pi/src/host-compatibility.ts`, tests in `packages/adapters/pi/src/__tests__/` (existing prober/compat test files plus new cases).
  - **Depends on**: Task 1 (contract names).
  - **Implementation outline**:
    1. Declare the four probe capabilities with stable names and severities (required-for-delegation vs overlay-only).
    2. Implement probes against the mocked host port; wire failure into the existing health-only path with the strong-debug diagnostic shape from Spec 33.
    3. Distinguish overlay-only capability gaps and route them to the custom-editor fallback flag consumed later by Task 12.
  - **Pitfalls / non-goals**:
    - Do not raise `HOST_VERSION_FLOOR`; 0.83 is the tested harness, 0.81.1 stays the floor.
    - Probes must be side-effect free (no session created during probing).
  - **Acceptance**:
    - `bun test packages/adapters/pi/src/__tests__/capability-prober.test.ts` (and compat tests) pass with new cases: each probe missing ⇒ correct mode + diagnostic fields; all present ⇒ ready.
    - Health-only diagnostics name the missing capability, version, contract, probe, mode, and remediation.

- [x] 4. Implement the native child session manager
  - **What**: New adapter module owning child native Pi v3 sessions: create under `$XDG_DATA_HOME/weave/adapters/pi/sessions/` (user-only permissions, strict root containment), set `parentSession` to the parent session, resolve/open for read (live and historical), explicit delete-with-confirmation producing an appended tombstone record, and missing/corrupt detection surfacing repair/remove options. No auto pruning, no transcript duplication.
  - **Files**: `packages/adapters/pi/src/child-native-sessions.ts` (new), reuse `packages/adapters/pi/src/path-containment.ts`; tests `packages/adapters/pi/src/__tests__/child-native-sessions.test.ts` (new).
  - **Depends on**: Tasks 1–3.
  - **Implementation outline**:
    1. Define the session root resolver (XDG fixed, `~/.local/share/weave` default) and directory/file creation with user-only modes, using `path-containment.ts` no-follow/containment helpers.
    2. Implement create/open/list-by-ref/delete/tombstone APIs returning `ResultAsync` with a discriminated error union (`SessionRootViolation`, `SessionMissing`, `SessionCorrupt`, `SessionPermissionError`, `TombstoneAppendFailed`, ...).
    3. Ensure created sessions are invisible to Pi's default session discovery (isolated root) — assert path disjointness in tests.
    4. Corrupt/missing sessions return typed states the UI maps to "unavailable + repair/remove"; deletion requires an explicit confirmation token from the caller.
  - **Pitfalls / non-goals**:
    - Session persistence failure must fail before the child task starts; never fall back to an ephemeral `--no-session` child.
    - Do not implement rendering or refs here; this module is storage-only.
    - Tombstones append; they never rewrite or truncate prior records.
  - **Acceptance**:
    - New test file passes under `bun test packages/adapters/pi/src/__tests__/child-native-sessions.test.ts`: containment rejection, permission modes, parentSession link, tombstone append, corrupt/missing typed states, no-default-tree visibility.
    - `bun run typecheck` passes.

- [x] 5. Implement parent custom-entry child refs with origin authority
  - **What**: New module writing/reading validated bounded child refs and lifecycle metadata into the parent session's custom entries via `appendEntry`: opaque child/thread ID, native session ID, root-relative ref, immutable originating parent session + entry IDs, title/status/times/runs. Fork/clone-copied refs whose recorded origin does not match the current parent session are ignored and confer no history or authority.
  - **Files**: `packages/adapters/pi/src/child-session-refs.ts` (new), Zod schema colocated or in `packages/adapters/pi/src/types.ts`; tests `packages/adapters/pi/src/__tests__/child-session-refs.test.ts` (new).
  - **Depends on**: Task 4.
  - **Implementation outline**:
    1. Define the ref schema (Zod, strict, bounded string lengths) and versioned entry envelope; validation failures yield typed `ChildRefInvalid` results, never throws.
    2. Implement append (new child, run divider metadata, status/lifecycle updates) and read (scan parent entries via `get_entries`, filter by origin match, newest-first) APIs.
    3. Origin check: recorded originating parent session ID must equal the live parent session ID; mismatch ⇒ silently excluded from picker/history (observed only by doctor as an informational count).
    4. Refs are observations: no API may use a ref to resurrect or mutate a child session absent the authoritative session file.
  - **Pitfalls / non-goals**:
    - Raw messages never enter custom entries — metadata only.
    - Do not write parent entries for children the parent does not own.
  - **Acceptance**:
    - `bun test packages/adapters/pi/src/__tests__/child-session-refs.test.ts` passes: schema bounds, origin mismatch exclusion, run metadata append, malformed-entry tolerance (skip + typed issue).
    - No transcript content appears in any serialized ref (asserted in tests).

- [x] 6. Implement the rebuildable metadata-only SQLite cache
  - **What**: Adapter-owned `bun:sqlite` cache for bounded discovery (list newest N, cursor pagination, cross-session history) storing metadata only — never transcripts or parent content. Source entries first, cache second; cache rebuilds from parent entries + child session files and degrades (bypassed) without blocking execution. User-only permissions, strict root containment under the adapter XDG root.
  - **Files**: `packages/adapters/pi/src/child-metadata-cache.ts` (new); tests `packages/adapters/pi/src/__tests__/child-metadata-cache.test.ts` (new).
  - **Depends on**: Tasks 4–5.
  - **Implementation outline**:
    1. Schema: children(thread_id, native_session_id, origin_parent_session, origin_entry_id, title, status, created/updated/settled times, runs, workspace key), schema-version table; open/create with 0600.
    2. Read path: query helpers used by picker `/weave:history` and CLI; every read validates against source on access of a specific child (source-of-truth check) and marks stale rows.
    3. Rebuild: full rescan API from parent entries + session files; corruption or open failure ⇒ typed degraded mode where callers fall back to direct entry scans (bounded).
    4. Delete/tombstone events update the cache; tombstoned children remain listed as tombstones, not resurrectable.
  - **Pitfalls / non-goals**:
    - Cache absence must never block delegation, settlement, or the overlay for the current parent's live children.
    - No cross-contamination: workspace/parent scoping keys on every query.
  - **Acceptance**:
    - `bun test packages/adapters/pi/src/__tests__/child-metadata-cache.test.ts` passes: rebuild-from-source equivalence, corrupt-cache degrade path, scoping, tombstone handling, permission modes.
    - Grep-level assertion in tests that no transcript field exists in the schema.

- [x] 7. Enforce the persistent-parent requirement
  - **What**: Detect `--no-session` (non-persistent) parent sessions; block delegation with structured `PersistentParentSessionRequired` diagnostics (stable code, remediation) while keeping safe read-only UI (picker/history/doctor over prior data where resolvable) available.
  - **Files**: `packages/adapters/pi/src/primary-session.ts`, `packages/adapters/pi/src/delegation-tool.ts` (guard), `packages/adapters/pi/src/errors.ts`; tests in `packages/adapters/pi/src/__tests__/primary-session.test.ts`, `delegation-tool.test.ts`.
  - **Depends on**: Tasks 4–5 (needs the ref/session model to define "read-only remains safe").
  - **Implementation outline**:
    1. Add persistent-session detection to the primary-session state (host probe of session identity/persistence).
    2. `weave_delegate` returns the structured error before any child session creation; diagnostics explain the cause and remediation (start Pi with a persistent session).
    3. Read-only surfaces stay mounted; steering/follow-up/retry/continue/delete are disabled with the same diagnostic.
  - **Pitfalls / non-goals**:
    - Do not partially create child sessions before the guard runs.
  - **Acceptance**:
    - Tests prove: non-persistent parent ⇒ delegation fails with `PersistentParentSessionRequired`, zero session files created; read-only surfaces still function against fixtures.

- [x] 8. Implement the child result contract (`ChildResponseMissing`)
  - **What**: A valid child result requires a parent-observed non-whitespace terminal assistant response. Empty/whitespace-only/thinking-only/tool-only completion becomes retryable `ChildResponseMissing`, preserving the transcript and releasing capacity.
  - **Files**: `packages/adapters/pi/src/errors.ts`, `packages/adapters/pi/src/delegation-controller.ts`, `packages/adapters/pi/src/rpc-child.ts`, `packages/adapters/pi/src/child-session-events.ts`; tests `packages/adapters/pi/src/__tests__/delegation-controller` / `rpc-child.test.ts` additions and a dedicated `child-response-contract.test.ts` (new).
  - **Depends on**: Task 4 (settlement writes against native sessions).
  - **Implementation outline**:
    1. Track the terminal assistant message through parser-approved event flow; classify at settlement.
    2. Add `ChildResponseMissing` to the error union with `retryable: true`, child/run/parent/correlation IDs, no transcript content.
    3. Settlement drains final events before classification; capacity release on settlement regardless of outcome.
  - **Pitfalls / non-goals**:
    - Thinking blocks and tool results must not satisfy the contract even when long.
    - Do not delete or truncate the child transcript on this failure.
  - **Acceptance**:
    - Regression tests cover: valid response, whitespace-only, thinking-only, tool-only, out-of-order final events; each asserts retryability, transcript preservation, and capacity release. `bun test packages/adapters/pi/src/__tests__/child-response-contract.test.ts` passes.

- [x] 9. Extend `weave_delegate` with thread lifecycle (start/retry/continue)
  - **What**: Compatible extension: existing `{agent, task}` = start new thread. Add retry (retryable failed OR cancelled thread) and continue (completed thread, task required). Same logical child/native session across runs; new tool block per run; old block frozen. Reopen the active leaf and append a divider entry with run/action/time/prior outcome/model/reasoning/initiator. Retry uses a default bounded continuation instruction or an optional caller instruction. Results expose opaque thread ID, run number, status, retryability, final response/error — no paths. Owner or authenticated ancestor with explicit transfer only. Retry/continue count toward `max_children` while running; settlement releases. Preserve agent/native model state; revalidate current tool/skill policy per run. Already-running/stale/integrity failures are structured errors.
  - **Files**: `packages/adapters/pi/src/delegation-tool.ts`, `packages/adapters/pi/src/delegation-controller.ts`, `packages/adapters/pi/src/child-transfer.ts`, `packages/adapters/pi/src/errors.ts`, `packages/adapters/pi/src/types.ts`; tests `delegation-tool.test.ts`, `delegation-controller` tests, new `thread-lifecycle.test.ts`.
  - **Depends on**: Tasks 4–8.
  - **Implementation outline**:
    1. Extend the tool schema compatibly (optional thread action/thread ID fields); absent fields preserve today's start semantics byte-for-byte.
    2. Implement thread resolution: ref lookup ⇒ authority check (owner/authenticated ancestor + explicit transfer via `child-transfer.ts`) ⇒ state check (retryable-failed/cancelled for retry; completed for continue) ⇒ structured errors (`ThreadAlreadyRunning`, `ThreadStale`, `ThreadIntegrityError`, `ThreadNotRetryable`, ...).
    3. Run mechanics: reopen native session at active leaf, append divider custom entry (run/action/timestamp/prior outcome/model/reasoning/initiator), dispatch run; update refs (Task 5) and cache (Task 6) with run count/status.
    4. Capacity: running retry/continue holds a `max_children` slot; settled releases (parallel-cap semantics, not cumulative).
    5. Policy: revalidate tool/skill policy against current config at each run start; preserve the child's native model/agent state.
  - **Pitfalls / non-goals**:
    - Never mutate or unfreeze the previous run's tool block; per-run block identity is new.
    - Results must not leak filesystem paths or native session paths.
    - Continue without a task is a validation error, not a default instruction.
  - **Acceptance**:
    - `bun test packages/adapters/pi/src/__tests__/thread-lifecycle.test.ts` passes: start/retry/continue happy paths, each structured error, capacity hold/release, divider content, policy revalidation, ancestor-transfer authority, no-path leakage.
    - Existing `delegation-tool.test.ts` start-path tests pass unchanged (compatibility).

- [x] 10. Implement session-transition pre-hooks and shutdown semantics
  - **What**: Awaited pre-hooks on parent session/new/resume/fork/clone and branch/tree changes: prompt with default **Stay**; on confirmed transition cancel all active/queued owned descendants and await origin settlement metadata before the transition proceeds; veto the transition on hook failure. New parent sessions see no old-child notice or data. Quit/reload performs bounded cancel then force-stop. Parent deletion leaves orphan read-only history. Fork/clone ref-origin rejection (Task 5) keeps new branches authority-free.
  - **Files**: `packages/adapters/pi/src/extension.ts` (hook registration), `packages/adapters/pi/src/delegation-controller.ts` (cancel-all/await-settlement API), `packages/adapters/pi/src/child-runtime.ts`; tests in `extension.test.ts`, `delegation-controller` tests, new `session-transition.test.ts`.
  - **Depends on**: Tasks 5, 8, 9.
  - **Implementation outline**:
    1. Register awaited pre-hooks on every transition surface the Pi extension API exposes (session switch, resume, fork, clone, branch/tree navigation).
    2. Hook flow: active/queued owned descendants exist ⇒ modal prompt defaulting Stay ⇒ on proceed, cancel subtree, await settlement metadata write-back to origin refs, then allow transition; failure ⇒ veto with diagnostic.
    3. Quit/reload path: bounded-time cancellation, then force-stop; assert no residual child process.
    4. Orphan behavior: deleting a parent leaves child sessions readable via history/doctor as read-only orphans.
  - **Pitfalls / non-goals**:
    - Hooks must be awaited by the host; if a transition surface cannot be pre-hooked, it must be probed (Task 3) and documented, not silently unguarded.
    - Do not write settlement metadata into the destination (new) session.
  - **Acceptance**:
    - `bun test packages/adapters/pi/src/__tests__/session-transition.test.ts` passes: Stay default, cancel-then-transition ordering, veto on failure, no old-child data post-transition, quit force-stop bound, orphan read-only access.

- [x] 11. Implement compact `weave_delegate` tool-block rendering
  - **What**: Replace the current compact rendering with the native-style block: native header; while running, only the latest meaningful raw non-whitespace activity fragment in a 3-line collapsed tail (expanded current item when the block is expanded); on settlement, final assembled response tail or error. Uses Pi normal render scheduling, parser-approved event flow, stable IDs/dedup/out-of-order placeholders, terminal control sanitization; settlement drains final events. Nested delegation renders the same compact block. UI errors are isolated from execution.
  - **Files**: `packages/adapters/pi/src/child-compact-render.ts` (new), `packages/adapters/pi/src/child-session-events.ts`, `packages/adapters/pi/src/child-native-components.ts`, wiring in `packages/adapters/pi/src/extension.ts` and `delegation-controller.ts`; tests `child-compact-render.test.ts` (new).
  - **Depends on**: Tasks 8–9 (event/settlement shapes).
  - **Implementation outline**:
    1. Event reducer: parser-approved child events ⇒ latest meaningful fragment selection (skip whitespace/control-only), stable per-item IDs, dedup, placeholder slots for out-of-order arrival.
    2. Renderer: native theme/status text + symbols via the existing opaque theme port; fixed 3-line collapsed tail; expanded mode shows current item fully; settled mode shows assembled final response tail or error summary.
    3. Sanitize all child-sourced text for terminal control sequences before rendering.
    4. Route through Pi's normal render scheduling (no bespoke timers); ensure render errors are caught and rendered as a degraded native block without affecting the child run.
  - **Pitfalls / non-goals**:
    - Never render thinking/tool noise as the "final response"; final tail comes only from the Task 8 contract result.
    - The compact block never exposes paths or session IDs.
  - **Acceptance**:
    - `bun test packages/adapters/pi/src/__tests__/child-compact-render.test.ts` passes: every event transition (start, first fragment, replacement, out-of-order, settle-success, settle-error, retry-new-block/frozen-old-block), sanitization, 3-line invariant, render-error isolation.

- [x] 12. Implement the full-screen focused child overlay
  - **What**: One full-screen native-style overlay showing the complete child transcript live and historical: prompt first, then user/assistant/thinking/tools/errors/retries/images with native components; pagination; search; live-tail with scroll preservation; resize; global expansion toggle; branch/history navigation across runs; steering (Enter) and follow-up (Alt+Enter) for active children; settled children read-only; renderer failure falls back to the existing custom-editor path. Focused input never leaks to the primary editor; drafts and scroll positions are preserved per child. Pi-vim coexistence preserved.
  - **Files**: `packages/adapters/pi/src/child-overlay.ts` (new), reusing/absorbing `child-transcript.ts` (native entry rendering), `child-native-components.ts`, `child-inspection-editor.ts` (fallback), wiring in `extension.ts`; tests `child-overlay.test.ts` (new) plus updates to `child-transcript.test.ts`.
  - **Depends on**: Tasks 4–6 (historical reads), 8–9 (live events, steering targets), 11 (shared event reducer).
  - **Implementation outline**:
    1. Transcript source: live children stream via the Task 11 reducer; historical children load pages from the native session file (bounded window pagination, cursor both directions).
    2. Compose native components per entry kind (prompt, user, assistant, thinking, tool call/result, error, retry divider, image) through the opaque TUI/theme port.
    3. Interaction: search within loaded window with on-demand page fetch; live-tail toggles off on manual scroll and resumes on bottom; resize reflows; global expansion state; run/branch navigation from divider metadata.
    4. Input routing: overlay owns the keyboard while mounted; Enter submits steering to active child; Alt+Enter submits follow-up; settled ⇒ input disabled read-only banner; unmount restores primary editor state and pi-vim mode.
    5. Renderer try/catch boundary ⇒ typed fallback that opens the custom-editor inspection path (existing module) with the same transcript.
  - **Pitfalls / non-goals**:
    - Bounded memory: never load the whole transcript for large sessions; performance tests pin the window size.
    - Only one overlay instance ever; opening another child swaps content, not stacks.
    - Do not add a second overlay implementation for nested children — nested sessions open through hierarchy into the same overlay.
  - **Acceptance**:
    - `bun test packages/adapters/pi/src/__tests__/child-overlay.test.ts` passes: live vs historical, pagination both directions, search paging, live-tail/scroll rules, resize, expansion, branch navigation, read-only settled, input isolation (no leakage events reach primary editor fake), draft/scroll preservation, fallback trigger.
    - pi-vim coexistence covered by an extension-level test (mode restored after unmount).

- [ ] 13. Implement overlay keys, picker, and hierarchy navigation
  - **What**: Named configurable Pi actions: Alt+I picker; Alt+1..9 active children; Alt+Left/Right and Alt+H/L siblings; empty Backspace = parent (or close overlay when direct); single Escape consumed and arms a hint; double Escape within 750 ms opens cancel-subtree confirmation defaulting **Keep running**. Conflicts with existing user keybindings are reported, never overwritten. Picker lists all statuses with title + local timestamp, active first then newest settled; title precedence: explicit child title, then task first line, then workflow step, then agent.
  - **Files**: `packages/adapters/pi/src/child-picker.ts`, `packages/adapters/pi/src/child-overlay-keys.ts` (new), `packages/adapters/pi/src/child-tree-keys.ts` (extend/replace), wiring in `extension.ts`; tests `child-picker.test.ts` (new/extended), `child-overlay-keys.test.ts` (new).
  - **Depends on**: Tasks 6 (picker data), 12 (overlay).
  - **Implementation outline**:
    1. Register each binding as a named Pi action with defaults; detect conflicts via the keybindings port and surface a report diagnostic instead of overriding.
    2. Implement the Escape state machine (consume, arm hint, 750 ms double-press window, cancel-subtree modal defaulting Keep running).
    3. Picker: query cache/source per Task 6 ordering and title precedence; hierarchy navigation maps Backspace/sibling keys over the ref tree.
  - **Pitfalls / non-goals**:
    - Escape must never fall through to Pi (which could clear the primary editor or exit modes) while the overlay is mounted.
    - Alt+1..9 index over active children in stable tree order (existing extension convention).
  - **Acceptance**:
    - Key tests pass: every binding routes correctly, conflict report path, Escape timing windows (< / > 750 ms), cancel modal default, Backspace parent-vs-close.
    - Picker tests pass: ordering, title precedence chain, all statuses present, local timestamp formatting.

- [ ] 14. Add commands, engine adapter-command dispatch boundary, and Pi CLI
  - **What**: `/weave:inspect` opens the current parent's active lineage; `/weave:history` shows bounded cross-session/all-branch history (first page before wider discovery); `/weave:doctor` runs diagnostics. Add a generic adapter-command dispatch boundary in the engine (opaque command name + opaque payload/result, no Pi parsing in core/engine) and bounded CLI: `weave adapter pi children list` (newest 50, current workspace, metadata only), `weave adapter pi children show <id>` (newest 100 + cursor), `weave adapter pi children delete <id>` (confirmation + tombstone), `weave adapter pi doctor`. Human-readable and stable JSON output; no paths except behind an explicit diagnostic flag.
  - **Files**: `packages/adapters/pi/src/commands.ts`, `packages/adapters/pi/src/extension.ts` (command routing), `packages/adapters/pi/src/adapter-cli-commands.ts` (new; Pi-side handlers), `packages/engine/src/adapter.ts` + `packages/engine/src/adapter-command.ts` (new; generic dispatch contract), `packages/cli/src/commands/adapter.ts` (new, following `runtime.ts` pattern), CLI index wiring; tests: engine `__tests__` for the dispatch contract, `packages/cli/src/commands/__tests__/adapter.test.ts` (new), adapter command tests.
  - **Depends on**: Tasks 5–6 (data), 12–13 (inspect opens overlay), 15 (doctor logic — command shell can land first with doctor wired in Task 15).
  - **Implementation outline**:
    1. Engine: define `AdapterCommandRequest { adapter, command, payloadJson }` / `AdapterCommandResult` with `Result` errors; the engine validates only envelope shape and routes to the registered adapter — payload semantics stay adapter-owned. Check the ownership matrix in `docs/architecture/adapter-boundary.md` before finalizing the signature.
    2. Pi adapter registers `children.list/show/delete` and `doctor` handlers over Tasks 4–6 APIs with the stated bounds and cursors.
    3. CLI command parses argv, calls the engine dispatch, renders human or `--json` stable output; delete requires interactive confirmation or `--yes`.
    4. Extension commands: `/weave:history` uses the same handler as CLI list (bounded first page), `/weave:inspect` resolves active lineage and opens the overlay/picker.
  - **Pitfalls / non-goals**:
    - No Pi types or Pi parsing may appear in `packages/engine` or `packages/core`; only opaque envelopes.
    - JSON output shape is a stability contract — snapshot-test it.
    - No cross-contamination: list/show scope to workspace/parent lineage keys.
  - **Acceptance**:
    - Engine dispatch tests pass with a fake adapter; grep proves no `@weaveio/weave-adapter-pi` import in engine/core.
    - `bun test packages/cli/src/commands/__tests__/adapter.test.ts` passes: bounds (50/100+cursor), JSON stability snapshot, delete confirmation + tombstone, no-path default, diagnostic flag path.

- [ ] 15. Implement diagnostics and doctor
  - **What**: Stable diagnostic codes carrying child/run/parent/correlation IDs and never raw prompt/transcript content. Doctor checks: capability probes, permissions, session/ref/cache integrity, stale markers, bounded orphan scan; produces an explicit sanitized JSON report on request; no standalone log files. History/doctor remain safe read-only in health-only mode.
  - **Files**: `packages/adapters/pi/src/child-doctor.ts` (new), `packages/adapters/pi/src/errors.ts` (codes), `packages/adapters/pi/src/telemetry.ts` (sanitization reuse), wiring into Task 14 handlers; tests `child-doctor.test.ts` (new).
  - **Depends on**: Tasks 3–6, 14 (command shell).
  - **Implementation outline**:
    1. Central diagnostic-code registry with Zod-validated shapes; sanitizer strips any transcript-like field defensively.
    2. Doctor pipeline: run each check as an isolated `ResultAsync`, aggregate into the report; bounded orphan scan (fixed page) never walks unbounded trees.
    3. Health-only gating: doctor and history handlers are registered in the health-only command set.
  - **Pitfalls / non-goals**:
    - No file logging; report is returned to the caller only.
    - Doctor is read-only; repair/remove actions route through existing explicit APIs (Tasks 4, 14), not doctor side effects.
  - **Acceptance**:
    - `bun test packages/adapters/pi/src/__tests__/child-doctor.test.ts` passes: each check's pass/fail shape, sanitization (seeded transcript text never appears in report), health-only availability, orphan bound.

- [ ] 16. Remove the JSONL child-history store and stale settings
  - **What**: Delete the legacy store and its configuration surface once all replacement paths are live: `child-history-fs.ts`, `child-history-schema.ts`, `child-history-store.ts`, `child-inspection-settings.ts` (quota/retention settings: `persist_history`, `max_bytes_per_child`, `max_bytes_total`, `orphan_retention_days`, `recovery_enabled`, `recovery_countdown_seconds`), the `childHistoryStoreFactory` wiring in `extension.ts` (~lines 548/657/3809), and JSONL-era code paths in `recovery-pointer.ts`, `child-session-checkpoint.ts`, `child-tree.ts`, `delegation-controller.ts`, `errors.ts`, `rpc-child.ts`, `child-framing.ts`. Remove or rewrite their tests. Remove any core/config schema keys that exist only for those settings.
  - **Files**: deletions above plus `packages/adapters/pi/src/index.ts` exports, corresponding `__tests__` files (`child-history-*`, `child-recovery.test.ts` portions, `child-inspection-*` where superseded), and — only if grep proves they carry the old settings — `packages/core/src/schema.ts` / `packages/config` surfaces.
  - **Depends on**: Tasks 4–15 (replacements complete).
  - **Implementation outline**:
    1. `rg -n "child-history|ChildHistory|childHistoryStoreFactory|index\.v1" packages docs` and enumerate every reference before deleting.
    2. Delete modules, exports, wiring, and settings; rewrite recovery/checkpoint code to source from native sessions + refs (Tasks 4–5).
    3. Update or delete affected tests in the same commit; per the no-migration decision, ship no migration code and no deletion of users' old on-disk JSONL data.
  - **Pitfalls / non-goals**:
    - This is the highest-collision task with the dirty worktree (`child-transcript.ts`, `child-tree.ts`, `delegation-controller.ts`, `extension.ts` and their tests are already modified). Reconcile against the in-worktree versions, not HEAD, and keep unrelated dirty hunks intact.
    - Do not remove `child-inspection-editor.ts` — it is the overlay fallback (Task 12).
  - **Acceptance**:
    - `rg "child-history|ChildHistory|index\.v1" packages` returns no source hits (docs may mention it historically in ADR 0013 only).
    - `bun test packages/adapters/pi` and `bun run typecheck` pass; `bun run validate-config` passes with the settings removed.

- [ ] 17. Cross-cutting test suites (concurrency, isolation, performance, regression)
  - **What**: Add the acceptance-mandated suites not covered per-module: concurrent/nested/out-of-order delegation isolation and capacity; parent reload/recovery; retry/continue across reload; tombstone/missing/corrupt/cache-degrade flows; response-contract regression matrix; no child session appears in `/resume` (default session tree isolation); transition cancellation ordering; bounded-window performance for large transcripts; minimum (0.81.1 contract) and current-host capability diagnostics; health-only read-only behavior; pi-vim coexistence.
  - **Files**: `packages/adapters/pi/src/__tests__/child-isolation.test.ts` (new), `child-recovery.test.ts` (rewrite), `child-performance.test.ts` (new), extensions to `extension.test.ts`, `fakes/fake-pi-host.ts`, `fakes/fake-child-process-port.ts`.
  - **Depends on**: Tasks 4–16.
  - **Implementation outline**:
    1. Extend fakes to model persistent sessions, entry trees, fork/clone, and session-dir listing so `/resume`-isolation is assertable.
    2. Write scenario tests per the list above; performance test pins page-window sizes and asserts bounded reads on a synthetic large session.
    3. Mock-only: no live harness in unit/integration tests (boundary rule).
  - **Pitfalls / non-goals**:
    - Timing-sensitive tests (Escape window, settlement drain) must use injected clocks (`child-timer.ts` pattern), never real sleeps.
  - **Acceptance**:
    - `bun test packages/adapters/pi` passes; each scenario in the list maps to at least one named test.
    - `bun test && bun run typecheck && bun run lint` pass workspace-wide.

- [ ] 18. Update docs (adapter, commands, keybindings, storage, recovery, CLI, troubleshooting)
  - **What**: Bring all user/contributor docs to the shipped behavior: Pi adapter guide (compact block, overlay, keys, picker, thread lifecycle, persistent-parent requirement, storage layout, cleanup/tombstones, orphans), adapter boundary (adapter-command dispatch), CLI reference (`weave adapter pi ...`), delegation reference (retry/continue, `ChildResponseMissing`, capacity semantics), adapter-capabilities (new probes), troubleshooting (diagnostic codes, doctor, repair/remove), and the no-migration note for prior JSONL users.
  - **Files**: `docs/adapters/pi.md`, `docs/architecture/adapter-boundary.md`, `docs/reference/cli.md`, `docs/reference/delegation.md`, `docs/reference/adapter-capabilities.md`, `docs/reference/configuration.md` (settings removal), `docs/guides/` troubleshooting page (locate exact file during execution), `docs/README.md` index if new pages are added.
  - **Depends on**: Tasks 1–17 (documents shipped behavior).
  - **Implementation outline**:
    1. Audit each file's current (dirty) content first; several are already modified for other work — edit surgically.
    2. Document keybindings as named configurable actions with defaults and the conflict-report behavior.
    3. Record storage paths, permission model, and that cleanup is explicit-only.
  - **Pitfalls / non-goals**:
    - Do not document unshipped or gated-off behavior; docs land in the same commits as the behavior they describe where feasible (repo rule).
  - **Acceptance**:
    - `bun run docs:check-links` passes; every new command, key, error code, and CLI subcommand named in this plan appears in docs.

- [ ] 19. Weft gate
  - **What**: Run the repository's Weft review gate over the completed change set and resolve every finding.
  - **Depends on**: Tasks 1–18.
  - **Implementation outline**:
    1. Run the Weft review per repo convention on the staged branch.
    2. Address findings with focused commits; re-run until approved.
  - **Pitfalls / non-goals**:
    - Do not defer findings to follow-up issues without explicit user approval.
  - **Acceptance**:
    - Weft reports approval for the branch with zero outstanding findings.

- [ ] 20. Real-harness proof on Pi 0.83 via Herdr
  - **What**: Prove every acceptance surface in a real Pi 0.83 harness following `docs/testing/adapter-verification.md`: launch each test in a fresh pane via `herdr agent`, close only the pane created for that individual test, and after every test prove no residual child process, no Runtime Store lease, and no leftover test-created pane. Never close or alter a pre-existing Herdr pane. Record proofs under Spec 33.
  - **Files**: `docs/specs/33-spec-pi-adapter/33-proofs/` (new proof records), `docs/specs/33-spec-pi-adapter/acceptance-manifest.json` (regenerate per tooling), `docs/specs/33-spec-pi-adapter/33-smoke-checklist.md` (check off procedure text, not plan tasks).
  - **Depends on**: Tasks 1–19.
  - **Implementation outline**:
    1. Test matrix (one fresh pane each, pane closed after each): (a) compact block live fragment + settlement tail; (b) overlay live tail + steering (Enter) + follow-up (Alt+Enter); (c) historical overlay after parent restart, pagination + search; (d) picker Alt+I ordering/titles, Alt+1..9, sibling keys, Backspace hierarchy; (e) double-Escape cancel-subtree defaulting Keep running; (f) retry of failed/cancelled thread and continue of completed thread with frozen old block; (g) `ChildResponseMissing` retryable path; (h) session transition prompt default Stay + cancel-then-switch; (i) fork/clone origin-mismatch ref exclusion; (j) `--no-session` parent → `PersistentParentSessionRequired` + read-only UI; (k) `/weave:history`, `/weave:doctor`, `weave adapter pi children list/show/delete` + tombstone; (l) no child session listed in Pi `/resume`; (m) pi-vim coexistence; (n) health-only read-only history/doctor with a capability artificially failed.
    2. After closing only the pane created for that test: verify with `pgrep -f` for child processes, `weave runtime status` for leases, and `herdr` pane listing. Confirm that every pre-existing pane remains untouched.
    3. Capture sanitized proof records (no transcripts/prompts) into `33-proofs/`.
  - **Pitfalls / non-goals**:
    - Never leave a test-created pane open between tests; never reuse a test pane across tests.
    - Never close, alter, or repurpose a Herdr pane that the test did not create.
    - Proofs must not contain raw child prompt/transcript content.
  - **Acceptance**:
    - Every matrix item has a proof record; each records that its test-created pane was closed, no test-created process/lease/pane remains, and all pre-existing panes were preserved; acceptance manifest validates against its schema.

- [ ] 21. Warp gate, staged commits, and issue-linked PR
  - **What**: Pass the mandatory Warp gate, deliver the work as focused staged Conventional Commits (schema+test+doc per commit; no commit exposes incomplete user-reachable behavior; no experimental dual path), and open an issue-linked PR. Restore the health-only restriction scope after merge (the exception covers only this plan).
  - **Depends on**: Tasks 1–20.
  - **Implementation outline**:
    1. Review the branch commit-by-commit: each commit builds, tests green, behavior gated until the enabling commit.
    2. Run Warp per repo convention; resolve findings.
    3. Open the PR referencing the tracking issue; include the proof summary and the ADR/no-migration note.
  - **Pitfalls / non-goals**:
    - Do not fold unrelated dirty-worktree changes into these commits.
  - **Acceptance**:
    - Warp approved; `bun test && bun run typecheck && bun run lint && bun run build && bun run docs:check-links` all pass at the branch head; PR open and issue-linked.

## Verification
Run at the branch head:

```bash
bun install
bun test                      # all packages green, including new pi adapter suites
bun run typecheck             # tsc --noEmit clean
bun run lint                  # biome + declaration validation clean
bun run build                 # public packages + docs site build
bun run validate-config       # .weave config valid after settings removal
bun run docs:check-links      # all doc links resolve
rg "child-history|ChildHistory|index\.v1" packages   # no source hits
```

Then confirm: Weft approved (Task 19), all Pi 0.83 Herdr proofs recorded with cleanup limited to panes created by each test, no residual test-created process/lease/pane, and all pre-existing panes preserved (Task 20), Warp approved and issue-linked PR open (Task 21).

## Plan-Level Risks and Unresolved Implementation Facts

Risks:

- **Dirty-worktree collision**: `extension.ts`, `delegation-controller.ts`, `child-transcript.ts`, `child-tree.ts`, and their tests are already modified for other in-flight work. Task 16 especially risks clobbering those edits; every task must diff against the working tree, not HEAD, and commit surgically.
- **`extension.ts` size**: at ~177 KB, wiring tasks (10–14) risk merge pain and review difficulty; extracting new logic into the named new modules is mandatory to keep `extension.ts` deltas small.
- **Host API coverage for pre-hooks**: if Pi's extension API cannot awaited-veto some transition surface (e.g., tree navigation), Task 10's guarantee weakens; Task 3's probes must detect this and the behavior must degrade to health-only or documented guard gaps rather than silent unguardedness.
- **Overlay performance**: native-component rendering of large historical sessions may exceed frame budgets even with bounded windows; the fallback path (custom editor) is the safety valve but must be exercised, not just coded.
- **No-migration user impact**: users with existing JSONL child history lose in-product access to it; docs mitigate but support burden is possible.

Unresolved implementation facts (to confirm during execution, not product decisions):

- Exact Pi 0.83 extension API names/signatures for: custom session directory configuration, `parentSession` linkage, session-transition pre-hooks with veto, `appendEntry`/`get_entries`/`get_tree` on the persistent RPC session, and named-action keybinding registration/conflict detection. Task 3 probes must be written against the real API surface read from the installed Pi docs/types.
- Whether the native v3 session file format tolerates adapter-appended divider custom entries on reopen-at-active-leaf without confusing Pi's own renderer; verify against the real harness early (spike inside Task 4/9 before Task 11 rendering work).
- The exact troubleshooting-doc file path under `docs/guides/` (locate during Task 18).
- Whether any `packages/core`/`packages/config` schema keys exist solely for the old child-inspection settings (grep during Task 16 decides removal scope).
- The precise Weft and Warp invocation commands per current repo convention (confirm at Tasks 19/21).
