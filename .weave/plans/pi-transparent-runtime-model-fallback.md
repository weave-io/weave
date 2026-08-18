# Pi Transparent Runtime Model Fallback

## TL;DR

Implement model fallback with only Pi 0.84.2's public extension API. Pi first completes its own retry, overflow-compaction, and queued-message recovery. Its payloadless `agent_settled` event then ends that low-level run. Weave delays only its own visible and child settlement, switches to the next eligible model with `pi.setModel`, and starts a new low-level run in the same process and native session by sending one hidden custom marker with `pi.sendMessage(..., { triggerTurn: true })`.

The exact marker's `message_start` proves dispatch. A public `context` handler then removes only that marker and the immediately preceding failed assistant from the provider-only message list. Both remain in durable Pi history. The fallback run sends no synthetic provider-level user message and does not use `agent.continue()`.

## Context

This plan replaces the earlier host-dependent design. It targets the installed Pi 0.84.2 behavior and public API only.

The verified Pi 0.84.2 lifecycle is:

1. `message_end` exposes the terminal assistant message, including a failed partial response.
2. Pi owns its native provider retry, overflow-compaction, and queued-message recovery paths.
3. Pi emits payloadless `agent_settled` only after those paths finish. Pi considers that low-level run settled.
4. Weave may defer its own visible, tool, and child settlement in its `agent_settled` handler.
5. Weave selects the next eligible candidate, calls public `pi.setModel`, and calls public `pi.sendMessage(marker, { triggerTurn: true })`.
6. `sendMessage` is fire-and-forget. The exact marker's `message_start` is the only dispatch proof. A bounded timeout fails closed if that event does not arrive.
7. The marker starts a new Pi low-level run in the same process and native session. Pi does not run `before_agent_start` for this recovery route.
8. The public `context` event receives a structured clone before provider conversion and may return a replacement message list. Weave removes the exact recovery pair from that provider-only list.

This creates an irreducible lifecycle split: Pi emits its internal `agent_settled` before fallback, and fallback is a new low-level run. Weave keeps the parent tool call, child, thread, and visible session pending so the user sees one uninterrupted operation. Weave cannot suppress Pi's internal event and must not claim that it does.

The provider-context repair is intentionally narrow:

- The hidden marker uses custom type `weave.model-fallback.recovery-marker`.
- Its `details` value has a strict schema with `schemaVersion: 1` and one RFC 4122 version-4 token created for the active generation and candidate transition.
- Admission requires one and only one custom-role message with the exact type and token.
- The failed assistant must be immediately before that marker and must match the bounded fingerprint retained from `message_end`.
- The `context` handler removes only those two entries from the provider-only clone and preserves the order and content of every other entry.
- The marker and failed assistant stay in durable Pi history. The failed partial output remains a failed-attempt record and is never joined to fallback output.
- The marker is filtered explicitly even if a host conversion would otherwise omit a custom message. The provider request must never depend on that conversion detail.
- The custom-message prompt route is mandatory. `agent.continue()` is prohibited because it validates the active last role before the `context` handler can remove the failed assistant.
- `model_select.source` does not prove whether the user or Weave caused a change. Ownership comes only from one exact provider/model expectation armed before `setModel`; every unmatched or ambiguous event is a manual override.

The adapter already has relevant seams under `packages/adapters/pi/src/`:

- `model-failover-contract.ts` contains useful bounded classification, candidate-cursor, resolution, eligibility, and preflight work, but its stale event assumptions and attempt-count model must be removed.
- `model-resolution.ts` resolves ordered model intent.
- `extension-impl.ts` owns primary and child lifecycle handlers, terminal assistant capture, direct-step windows, and final settlement.
- `child-compaction-settlement.ts` defers child settlement during compaction. Its current unrelated `turn_start` behavior can publish the retained failure and must not admit fallback recovery.
- `session-transition-runtime.ts`, `generation-resources.ts`, and `primary-session.ts` own generation and explicit agent-activation boundaries.
- `provider-fast-activation.ts` owns provider acceleration truth.
- `child-envelope.ts`, `child-control-bodies.ts`, `child-runtime.ts`, `rpc-child.ts`, `delegation-controller.ts`, and `child-tree.ts` own the authenticated, sequenced child-control boundary.
- `child-card-model.ts`, `child-card-render.ts`, and `delegation-tool.ts` own durable delegation-card facts and rendering.
- `child-overlay-pi-native.ts`, `child-overlay-replay.ts`, `child-overlay-search.ts`, and `child-session-events.ts` own child transcript, replay, search, and restart behavior.
- `host-compatibility-matrix.ts`, `capability-prober.ts`, `host-inventory.ts`, and their tests contain stale optional-feature assumptions that must be replaced with probes for the public surfaces used here.

All Pi-specific behavior stays in the Pi adapter. The engine, core, config schema, and `.weave` DSL already express ordered model intent and do not need a new fallback abstraction.

## Scope

- In scope:
  - Primary sessions and all Pi child modes: delegated, direct-step, and nested.
  - A bounded adapter-local coordinator with candidate cursor, conservative failure classes, catalog/auth preflight, context-window eligibility, exact marker correlation, manual override latch, generation/session resets, and exhaustion.
  - Public Pi 0.84.2 lifecycle handlers for `message_end`, `agent_settled`, `message_start`, `context`, and `model_select`.
  - Public `pi.setModel`, fire-and-forget `pi.sendMessage(..., { triggerTurn: true })`, and public idle/pending helpers.
  - Exact provider-context repair that removes only the failed assistant and its exact marker from the provider request.
  - Recovery-aware, exactly-once Weave settlement across compaction and fallback epochs.
  - Truthful provider/model updates through the authenticated child channel.
  - One strict durable read-only Model Fallback event per recovery-confirmed switch, with live, replay, search, and restart parity.
  - The approved delegation-card geometry and measured narrow-width degradation.
  - Optional capability probing, tests, current documentation, release smoke tooling, Weft review, mandatory Warp review, live Pi 0.84.2 proof, and rollback.
- Out of scope:
  - Changes to Pi itself or any dependency on a Pi API not present in installed 0.84.2.
  - Changes to Pi's native retry, backoff, compaction, or queued-message logic.
  - Private Pi imports or direct access to Pi internals.
  - Synthetic provider-level user messages, `agent.continue()`, process replacement, native-session replacement, or tool replay as a fallback mechanism.
  - Core, engine, config-schema, or `.weave` DSL changes.
  - New fallback behavior in non-Pi adapters.
  - Isolation from a malicious extension with full session access.
  - Standalone durable operational files or committed live-proof reports.
  - Interactive controls on the Model Fallback event or a second fallback card/banner.
- Constraints / assumptions:
  - Use Bun only. Do not add Node runtime APIs beyond the project exceptions.
  - Use `Result` or `ResultAsync` for expected failure paths. Wrap host calls that can throw or reject. Do not use `console.*`.
  - Keep raw provider errors, failed assistant content, credentials, tokens, and provider request bodies out of logs, control envelopes, UI facts, telemetry, and proof reports.
  - Fingerprint the failed assistant with a descriptor-safe, bounded canonical form and Bun/Web crypto. A throwing accessor, proxy trap, unsupported value, or exceeded bound disables fallback for that failure.
  - Treat other installed context handlers as trusted composition partners. Handlers registered after Weave receive Weave's filtered list. Handler order does not protect against a malicious full-access extension.
  - Keep the Pi host floor at 0.81.1. Runtime fallback is optional. Missing or unproven surfaces retain legacy settlement behavior and never cause health-only mode.
  - State exact tested behavior only for Pi 0.84.2 after the real-host proof passes. Use surface probes and dynamic marker/context proof instead of assuming identical ordering on every supported host.
  - Write no production or test implementation while editing this plan. Implementation commits must reference the related Weave issue and use Conventional Commits.

## Objectives

- Recover from a terminal provider failure with the next bounded eligible model while preserving the process, native session, thread, child identity, and parent tool call.
- Preserve Pi's native recovery authority and start fallback only after Pi emits its payloadless low-level settlement event.
- Keep the current failure authoritative until model application, exact marker dispatch, and exact context repair are all proven.
- Preserve every real user, task, tool, steering, follow-up, and unrelated message in provider context.
- Preserve the failed assistant and hidden marker in durable Pi history while excluding both from the fallback provider request.
- Prevent failed partial output from concatenating with successful fallback output.
- Detect manual model changes conservatively and stop automatic fallback until explicit Weave agent activation.
- Settle visibly and across the child protocol exactly once after final success, bounded chain exhaustion, cancellation, or fail-closed recovery failure.
- Show one read-only Model Fallback event for each recovery-confirmed switch. Show no event for a switch that applied but failed recovery admission.
- Keep the delegation card truthful: the applied provider/model updates atomically from authenticated facts, while the latest approved geometry remains normative.
- Prove the feature on real Pi 0.84.2 and keep older or incomplete hosts on safe legacy behavior.

## Dependencies and Order

1. Tasks 1–3 define the public contract, context-repair primitive, coordinator, and capability boundary.
2. Tasks 4–6 wire primary and child lifecycle behavior, settlement coordination, and authenticated model truth.
3. Task 7 proves provider-context and settlement security before UI work can claim a confirmed fallback.
4. Tasks 8–9 lock the visual design and implement the durable event, child projections, and card geometry.
5. Task 10 closes cross-mode and adversarial coverage.
6. Tasks 11–12 update current documentation and add repeatable release smoke tooling.
7. Task 13 runs repository verification and freezes the review range.
8. Task 14 requires Weft approval before any live credentials or real provider path is used.
9. Task 15 performs the real Pi 0.84.2 proof against the reviewed artifact.
10. Task 16 requires Warp approval of the exact live-proven range. Any fix invalidates the frozen range and repeats the affected verification and live proof.
11. Task 17 delivers with a tested rollback path.

## Tasks

- [x] 1. Replace the stale fallback contract with a public-lifecycle contract
  - **What**: Refactor the existing pure fallback code around terminal `message_end`, payloadless `agent_settled`, strict marker correlation, and exact provider-context repair.
  - **Files**: `packages/adapters/pi/src/model-failover-contract.ts`, `packages/adapters/pi/src/model-resolution.ts`, `packages/adapters/pi/src/model-failover-context.ts` (new), `packages/adapters/pi/src/__tests__/model-failover-contract.test.ts`, `packages/adapters/pi/src/__tests__/model-resolution.test.ts`, `packages/adapters/pi/src/__tests__/model-failover-context.test.ts` (new). Discovery targets: existing bounded canonicalization and hash helpers under `packages/adapters/pi/src/`.
  - **Depends on**: None.
  - **Implementation outline**:
    1. Remove stale event-payload and native-attempt-count assumptions. Accept only a parser-approved terminal assistant captured from `message_end`.
    2. Keep the closed safe failure classes: authentication failure, authorization failure, rate limit, provider unavailable, timeout, unrecovered context overflow, and unknown provider failure. Classify only bounded own data properties. Never retain raw provider text.
    3. Treat `stopReason: "error"` as the fallback candidate signal. Do not infer a failed overflow from `stopReason: "length"` alone. Never recover an aborted turn. Permit the closed known classes to advance after Pi's native recovery; permit an unknown provider failure to advance at most once in the prompt epoch, then fail closed.
    4. Keep ordered canonical distinct candidate resolution and a monotonic cursor that starts after the applied failed model, never wraps, and is capped by the frozen candidate list.
    5. For a classified context overflow, admit only a candidate with a strictly larger declared context window. Other classes do not compare context windows.
    6. Define marker type `weave.model-fallback.recovery-marker` and strict details `{ schemaVersion: 1, token: <UUID v4> }`. Use fixed bounded content and `display: false`.
    7. Compute a bounded fingerprint of the complete failed assistant. Bound message depth, property count, encoded bytes, and content-block count. Reject accessors, proxies, unsupported values, and noncanonical data without throwing.
    8. In the pure context-repair function, require exactly one custom-role marker with the exact type and token. Require its immediate predecessor to be an assistant with the retained fingerprint. Return a new list with exactly those two indexes removed.
    9. Preserve every other item byte-for-structure and in order. Never remove a message based only on role, text, similarity, or adjacency to an unrelated custom message.
  - **Pitfalls / non-goals**:
    - Do not store failed assistant content in coordinator facts after computing its bounded fingerprint.
    - Do not use a text sentinel as correlation.
    - Do not turn malformed provider errors into permissive recovery.
  - **Acceptance**:
    - Classification tests cover bounded 401/403/429/5xx/timeout/overflow/unknown shapes and adversarial descriptors without exceptions or raw-text escape.
    - Cursor tests prove order, canonical distinctness, no wrap, bounded exhaustion, and larger-window-only overflow eligibility.
    - Context tests prove exact marker/fingerprint/adjacency admission, exact two-item removal, stable order for all other messages, and fail-closed behavior for missing, duplicate, ambiguous, malformed, or misplaced markers.
    - Tests prove equal-looking but distinct failed assistants cannot be selected by loose text matching.

- [ ] 2. Build the bounded fallback coordinator
  - **What**: Add one adapter-local state machine that owns candidate selection, model switching, marker proof, context repair, manual override, resets, and exact terminal decisions.
  - **Files**: `packages/adapters/pi/src/model-failover-coordinator.ts` (new), `packages/adapters/pi/src/model-failover-preflight.ts` (new or extracted from the contract), `packages/adapters/pi/src/__tests__/model-failover-coordinator.test.ts` (new), `packages/adapters/pi/src/__tests__/model-failover-preflight.test.ts` (new), `packages/adapters/pi/src/__tests__/fakes/fake-pi-host.ts`.
  - **Depends on**: Task 1.
  - **Implementation outline**:
    1. Use the explicit states `armed`, `switching`, `awaiting-marker-proof`, `awaiting-context-repair`, `recovering`, `manually-overridden`, `exhausted`, and `terminal`. Do not hide lifecycle meaning in booleans.
    2. Scope each coordinator to one Weave generation, one native session identity, one explicit agent activation, and one frozen ordered candidate list.
    3. Retain the current epoch's original failure until exact marker start and valid context repair. A later fallback failure becomes the retained failure for the next epoch.
    4. Before switching, require public idle state, no public pending messages, current generation/session identity, catalog presence, auth availability, and context-window eligibility.
    5. Mark the exact expected provider/model before calling `pi.setModel`. Wrap synchronous throw and promise rejection with `neverthrow`; apply a bounded switch timeout.
    6. Treat `setModel(false)` as a candidate-local skip and continue boundedly. Treat catalog absence and auth-unavailable preflight as candidate-local skips. If every candidate skips, publish the retained failure once.
    7. Treat a `setModel` throw, rejection, timeout, or indeterminate applied state as a terminal fail-closed recovery error because model truth can be ambiguous. Publish the retained failure once instead of waiting for another Pi settlement.
    8. Consume exactly one matching `model_select` as internal proof. Do not trust its `source`. Arm the expectation before the host call and support the event arriving before or after the `setModel(true)` resolution; require both facts within one bounded switch window. Any event outside one unambiguous active expectation, or any unmatched, delayed, duplicate, or ambiguous event, enters `manually-overridden` until explicit Weave agent activation.
    9. After model proof, check idle, pending input, generation, session, and cancellation again. If the model already changed before a race is found, emit truthful applied-model facts but do not claim recovery.
    10. Call `pi.sendMessage(marker, { triggerTurn: true })` without awaiting it. Catch only a synchronous throw. Enter `awaiting-marker-proof` and start a bounded generation-owned timer.
    11. Admit dispatch only from `message_start` for the exact custom type/token. A bare `turn_start` or unrelated message never proves fallback.
    12. Enter `awaiting-context-repair`; require the Task 1 context function to succeed before the timeout. Only then enter `recovering`, suppress Weave settlement, and emit a recovery-confirmed transition.
    13. On final successful low-level settlement, enter `terminal` and settle once. On a later eligible error, advance the same bounded cursor. On cursor exhaustion, enter `exhausted` and publish the latest retained failure once.
    14. Reset and invalidate timers/tokens on session change, generation replacement, explicit agent activation, reload, and shutdown. Stale callbacks fail closed and cannot mutate a new generation.
    15. Distinguish an authenticated parent/user cancellation from recovery-local cancellation. Existing cancellation authority settles cancelled once. A stale or local recovery cancellation without terminal user authority publishes the retained original failure once.
  - **Pitfalls / non-goals**:
    - `sendMessage` is not an acknowledgment API. Do not treat its return as dispatch proof.
    - Never wait for a settlement after `setModel(false)`, an auth failure, or a thrown/rejected model call; those paths emit no Pi settlement.
    - Do not allow a new ordinary user turn to clear the manual override latch.
  - **Acceptance**:
    - State-table tests cover every legal transition and reject every illegal transition.
    - Tests cover candidate skips, later candidate success, switch throw/reject/timeout, marker timeout, context timeout, stale generation, session reset, explicit cancellation, and exact-once terminal callbacks.
    - Tests prove later fallback errors advance boundedly and never revisit a candidate.
    - Tests prove final success and chain exhaustion each settle once, with no double settlement after delayed events.

- [ ] 3. Replace stale host assumptions with an optional public-surface capability
  - **What**: Align narrow Pi types and compatibility probes with the public 0.84.2 surfaces used by the coordinator. Keep the feature optional on all other hosts.
  - **Files**: `packages/adapters/pi/src/types.ts`, `packages/adapters/pi/src/host-compatibility-matrix.ts`, `packages/adapters/pi/src/capability-prober.ts`, `packages/adapters/pi/src/host-inventory.ts`, `packages/adapters/pi/src/capability-declarations.ts`, `packages/adapters/pi/src/host-probe-port.ts`, and matching tests under `packages/adapters/pi/src/__tests__/` including `host-compatibility-matrix.test.ts`, `capability-prober.test.ts`, `host-inventory.test.ts`, `capability-declarations.test.ts`, `host-probe-port.test.ts`, `host-compatibility.test.ts`, and `safe-initializer.test.ts`.
  - **Depends on**: Tasks 1–2.
  - **Implementation outline**:
    1. Remove the stale optional surface and replace it with one adapter-owned `runtime-model-fallback` feature fact.
    2. Probe only the needed public surfaces: registration for `agent_settled`, terminal `message_end`, replacement-returning `context`, `message_start`, `model_select`, callable `setModel`, callable `sendMessage`, and callable idle/pending helpers.
    3. Align `PiExtensionApi.sendMessage` with its fire-and-forget public contract. Align `setModel` with its public async boolean result. Add the narrow pending-message helper to `PiSessionContext`.
    4. Use existing public `ctx.modelRegistry` and current model facts for catalog/auth preflight. If authenticated availability cannot be established, skip that candidate; do not inspect private auth state.
    5. Let static probing establish only surface presence. Every actual attempt still proves event order dynamically through exact marker start and exact context repair.
    6. Give this feature an optional severity. A missing surface reports bounded unsupported evidence, leaves health ready, and uses legacy visible/child settlement.
    7. Keep `HOST_VERSION_FLOOR` at 0.81.1 and set the exact-tested host fact to installed Pi 0.84.2 as the claim that Task 15 must prove before delivery.
  - **Pitfalls / non-goals**:
    - Do not infer capability from the version string alone.
    - Do not register an engine capability or alter required delegation surfaces.
    - Do not claim that surface presence proves lifecycle ordering.
  - **Acceptance**:
    - Fake hosts with any required optional surface missing stay ready, do not enter health-only mode, and use legacy settlement.
    - A complete fake host enables the coordinator, but malformed event ordering still fails per-attempt.
    - Capability output has bounded reason codes and no misleading claim that every supported Pi version has this behavior.
    - Existing required capability and health-only tests remain unchanged in meaning.

- [ ] 4. Wire primary-session recovery on the public lifecycle
  - **What**: Compose one coordinator into the primary session without changing Pi's internal settlement or creating a second session.
  - **Files**: `packages/adapters/pi/src/extension-impl.ts`, `packages/adapters/pi/src/primary-session.ts`, `packages/adapters/pi/src/session-transition-runtime.ts`, `packages/adapters/pi/src/generation-resources.ts`, `packages/adapters/pi/src/provider-fast-activation.ts`, `packages/adapters/pi/src/telemetry.ts`, `packages/adapters/pi/src/__tests__/extension.test.ts`, `packages/adapters/pi/src/__tests__/primary-session.test.ts`, `packages/adapters/pi/src/__tests__/session-transition-runtime.test.ts`, `packages/adapters/pi/src/__tests__/generation-resources.test.ts`, `packages/adapters/pi/src/__tests__/provider-fast-activation.test.ts`, `packages/adapters/pi/src/__tests__/telemetry.test.ts`.
  - **Depends on**: Tasks 2–3.
  - **Implementation outline**:
    1. Register the public lifecycle handlers once and route them to the generation-owned coordinator.
    2. At each `message_end`, parse and retain only bounded terminal assistant facts and fingerprint. Reset output assembly at a recovery boundary so failed partial output cannot prefix later success.
    3. At `agent_settled`, settle normally for success, abort, unsupported capability, manual override, or an unclassifiable failure. For an armed eligible failure, defer only Weave's visible settlement and start Task 2.
    4. Arm from the current explicit Weave agent activation and its resolved ordered distinct models. Keep the currently applied model as the cursor origin.
    5. Route `message_start`, `context`, and `model_select` through exact coordinator methods. The context handler returns Task 1's filtered clone only for the active token.
    6. Reset on all existing generation/session transitions. Explicit Weave agent activation is the only action that clears manual override and creates a new candidate snapshot.
    7. Recompute provider acceleration for the applied fallback candidate. Never carry a fast-provider claim from the prior provider or model.
    8. Keep telemetry bounded to closed failure class, canonical model identities, cursor position, and closed outcomes. Persist no raw failure or marker token there.
  - **Pitfalls / non-goals**:
    - Recovery skips `before_agent_start`; do not rely on it to rebuild prompts, tools, skills, or agent state.
    - Do not send a user-role message or call the public user-message API.
    - Do not hide an applied model change if a later recovery check fails.
  - **Acceptance**:
    - Integration tests show one primary failure, one model switch, exact marker proof, exact context repair, a successful new low-level run, and one final visible settlement in the same native session.
    - No `before_agent_start` assertion is required or faked for the recovery run.
    - Manual model selection latches fallback off until explicit Weave agent activation.
    - Provider/model badge and acceleration state report the actual applied model after every successful `setModel`, including a switch whose recovery later fails.

- [ ] 5. Generalize child settlement without mixing compaction and fallback epochs
  - **What**: Extend the child settlement gate so Pi compaction and Weave fallback have separate evidence and neither an unrelated turn nor a late event can publish twice.
  - **Files**: `packages/adapters/pi/src/child-compaction-settlement.ts` (rename only if a deeper interface results), `packages/adapters/pi/src/extension-impl.ts`, `packages/adapters/pi/src/repeated-settlement-validator.ts`, `packages/adapters/pi/src/__tests__/child-compaction-settlement.test.ts`, `packages/adapters/pi/src/__tests__/rpc-child-settlement-race.test.ts`, `packages/adapters/pi/src/__tests__/child-mode.test.ts`.
  - **Depends on**: Tasks 2–4.
  - **Implementation outline**:
    1. Represent compaction and fallback as separate epochs with separate evidence, timers, and terminal callbacks.
    2. Preserve the existing compaction contract for genuine structural compaction events.
    3. Remove the rule that any unrelated `turn_start` publishes a retained failure while fallback is pending.
    4. Admit a fallback run only from the exact custom marker's `message_start`; never from bare `turn_start`.
    5. Keep the child failure retained through marker proof and valid context repair. Once recovery is valid, discard only transient output assembly for the failed attempt; retain native history.
    6. Keep direct-step completion windows and delegation promises open through confirmed recovery. Close them only at final visible success, bounded exhaustion, authenticated cancellation, or fail-closed recovery termination.
    7. If marker dispatch, context adjacency, model application, auth/catalog resolution, stale generation, local recovery cancellation, or timeout fails, publish the retained original failure once. Authenticated parent cancellation still uses the existing cancelled terminal authority once.
  - **Pitfalls / non-goals**:
    - Do not make `turn_start` a generic recovery signal.
    - Do not let a compaction event satisfy fallback admission or a fallback marker satisfy compaction admission.
    - Do not close and reopen a direct-step window around the new low-level run.
  - **Acceptance**:
    - Tests enumerate compaction-only, fallback-only, compaction-then-fallback, fallback-later-failure, timeout, cancellation, and late-event races.
    - Every sequence produces exactly one Weave/child terminal settlement.
    - A bare `turn_start` never suppresses or releases fallback settlement.
    - Failed partial assistant output remains durable but never concatenates with successful child output.

- [ ] 6. Report applied and recovery-confirmed child model transitions securely
  - **What**: Extend the authenticated child-control protocol with nonterminal model-transition phases so the parent knows actual model truth and can distinguish application from confirmed recovery.
  - **Files**: `packages/adapters/pi/src/child-envelope.ts`, `packages/adapters/pi/src/child-control-bodies.ts`, `packages/adapters/pi/src/child-runtime.ts`, `packages/adapters/pi/src/rpc-child.ts`, `packages/adapters/pi/src/delegation-controller.ts`, `packages/adapters/pi/src/child-tree.ts`, `packages/adapters/pi/src/__tests__/child-envelope.test.ts`, `packages/adapters/pi/src/__tests__/child-control-bodies.test.ts`, `packages/adapters/pi/src/__tests__/child-runtime.test.ts`, `packages/adapters/pi/src/__tests__/rpc-child.test.ts`, `packages/adapters/pi/src/__tests__/delegation-controller.test.ts`, `packages/adapters/pi/src/__tests__/child-tree.test.ts`.
  - **Depends on**: Tasks 4–5.
  - **Implementation outline**:
    1. Add one strict bounded `model-transition` control body with phases `applied` and `recovery-confirmed`.
    2. Carry a schema version, transition ID, closed failure class, bounded canonical from/to identity, and phase. Do not carry raw errors, message content, credentials, or provider response data.
    3. Send `applied` only after `setModel(true)` and the exact expected `model_select` proof. This updates parent provider/model truth even if marker admission later fails.
    4. Send `recovery-confirmed` only after exact marker start and valid context repair. This authorizes the parent Native Line and the visible fallback event projection.
    5. Keep both phases nonterminal. They renew existing child activity but never consume settlement authority.
    6. Require the existing HMAC, direction, child identity, nonce, sequence, size, generation, and running-state checks. Reject duplicate, stale, reordered, or mismatched phases.
    7. Source every child candidate list from its authenticated frozen dispatch/bootstrap catalog. A later catalog publication cannot alter a running child's cursor.
  - **Pitfalls / non-goals**:
    - Do not infer a confirmed recovery from the applied phase.
    - Do not update provider and model in separate parent mutations.
    - Do not permit a transition control body after terminal child settlement.
  - **Acceptance**:
    - Valid applied facts update actual provider/model atomically and leave the parent tool pending.
    - Valid recovery-confirmed facts update the fallback projection once and leave the parent pending.
    - Tamper, replay, sequence, phase-order, identity, and post-terminal tests fail closed.
    - Delegated, direct-step, and nested children share the same protocol path and frozen candidate semantics.

- [ ] 7. Prove exact provider context and exact-once recovery behavior
  - **What**: Add focused integration tests around the fake Pi lifecycle and a captured provider-conversion boundary before any UI claims are accepted.
  - **Files**: `packages/adapters/pi/src/__tests__/model-failover-context.integration.test.ts` (new), `packages/adapters/pi/src/__tests__/model-failover-lifecycle.integration.test.ts` (new), `packages/adapters/pi/src/__tests__/extension.test.ts`, `packages/adapters/pi/src/__tests__/child-mode.test.ts`, `packages/adapters/pi/src/__tests__/fakes/fake-pi-host.ts`, existing provider fake/capture utilities discovered under `packages/adapters/pi/src/__tests__/`.
  - **Depends on**: Tasks 4–6.
  - **Implementation outline**:
    1. Model Pi's sequence precisely: failed `message_end`, payloadless `agent_settled`, asynchronous model selection, hidden marker send, exact marker `message_start`, `context`, provider conversion, later `message_end`, and later `agent_settled`.
    2. Capture both durable Pi history and the replacement list handed toward provider conversion.
    3. Include original task/user messages, tool calls/results, steering, follow-up, unrelated custom entries, a terminal failed assistant with partial output, the exact marker, and queued real user work.
    4. Assert that provider context preserves every real message and excludes only the exact failed assistant and marker.
    5. Assert that durable history still contains both removed entries and that successful fallback output is a separate assistant entry.
    6. Run malformed cases: no marker, duplicate token, duplicate marker, wrong token, wrong custom type, wrong role, missing failed assistant, nonadjacent assistant, fingerprint mismatch, concurrent queued input, and a context handler invoked after timeout.
    7. Register a trusted later context handler and assert it receives Weave's filtered list. State in the test name and docs that this proves composition, not hostile-extension isolation.
  - **Pitfalls / non-goals**:
    - Do not make the fake host silently repair invalid sequences that real Pi would expose.
    - Do not inspect provider requests by logging raw request bodies in production code.
  - **Acceptance**:
    - Tests prove original user/task/tool history is preserved.
    - Tests prove the exact failed assistant and marker are absent from the provider request while both remain durable.
    - Tests prove no real queued/user, steering, follow-up, tool, or unrelated message is removed.
    - Missing, duplicate, ambiguous, malformed, and nonadjacent markers fail closed.
    - The captured provider request contains no synthetic provider-level user message.
    - Later fallback errors advance boundedly, and all success/failure/race cases produce no double settlement.

- [ ] 8. Amend the prototype and normative UI design record
  - **What**: Preserve the approved read-only Model Fallback event and lock the latest delegation-card geometry before production rendering changes.
  - **Files**: `prototypes/weave-pi-tui-grilling.ts`, `prototypes/weave-delegate-tool-grilling.ts`, `docs/specs/33-spec-pi-adapter/33-weave-ui-design.md`.
  - **Depends on**: Tasks 6–7.
  - **Implementation outline**:
    1. Keep the Model Fallback event read-only and compact. It has no frame, footer, control, key hint, or second card. Its wide form is:
       ```text
       ▌ MODEL FALLBACK
       <from provider/model> → <to provider/model>
       <safe failure class> · native recovery exhausted · continuing in this session
       ```
    2. Render the event only for `recovery-confirmed`, exactly once per transition. An applied-only switch or chain exhaustion has no fallback event; ordinary failure rendering remains authoritative.
    3. Use semantic `Seg`/`Row` facts and color-plus-shape identity. At narrow widths, drop the secondary row first with one explicit ellipsis, then drop the origin while preserving `→ <destination>`. Preserve the fallback identity and destination at every viable width.
    4. Keep this delegation-card geometry normative:
       ```text
       ╭─ Shuttle ... ╮
       ▌ RUNNING openai-codex │ Rewrite the retry coordinator.
                 gpt-5.6-luna │ ⏵ edit model-failover.ts
                              │
       ╰─ run 1 · reasoning ... Ctrl+O expand · Alt+I ... ╯
       ```
    5. Keep the agent display name bold and Title Case in the top frame. Keep canonical normalized names for protocol, lookup, storage, and authorization.
    6. Put the authenticated applied provider and model in the stacked rail. Update both atomically on an applied transition. Keep the third row blank and elapsed time in the footer only.
    7. Measure narrow bands in the prototype and record exact thresholds. Protect body minimum, assignment, Native Line, and status first; shed provider before model; then fold the rail into bounded identity rows. Keep the status bar/word and frame-title agent as the strongest identities.
    8. Amend the relevant locked decisions and production mapping in the existing design record. Record prototype anchors for every geometry and degradation rule.
  - **Pitfalls / non-goals**:
    - Do not guess numeric width bands in production before prototype measurement.
    - Do not add controls to the event or fill the blank card row.
    - Do not render raw provider error text or opaque correlation data.
  - **Acceptance**:
    - Prototype snapshots cover wide, each measured narrow band, plain paint, and all card terminal states at stable collapsed height.
    - The design record explicitly locks the exact event copy, event drop order, card frame title, stacked applied identity, blank third row, footer-only elapsed value, and atomic failover update.
    - The design record states that no event appears for an applied-only switch or ordinary exhaustion.

- [ ] 9. Implement the durable event, replay parity, and approved card geometry
  - **What**: Port Task 8 into strict durable records, primary/child rendering, replay/search/restart paths, and delegation-card facts.
  - **Files**: `packages/adapters/pi/src/model-failover-record.ts` (new), `packages/adapters/pi/src/model-fallback-event-render.ts` (new), `packages/adapters/pi/src/agent-display-name.ts` (new), `packages/adapters/pi/src/child-card-model.ts`, `packages/adapters/pi/src/child-card-render.ts`, `packages/adapters/pi/src/delegation-tool.ts`, `packages/adapters/pi/src/child-overlay-pi-native.ts`, `packages/adapters/pi/src/child-overlay-replay.ts`, `packages/adapters/pi/src/child-overlay-search.ts`, `packages/adapters/pi/src/child-session-events.ts`, `packages/adapters/pi/src/types.ts`, and matching renderer/model/replay/search/restart tests.
  - **Depends on**: Task 8.
  - **Implementation outline**:
    1. Define strict custom entry `weave.model-failover` with schema version, transition ID, closed safe failure class, and bounded canonical from/to provider/model identities. Reject extra, malformed, accessor-backed, or oversized fields.
    2. Append it locally to the active native Pi session only after valid context repair. Deduplicate by transition ID so one confirmed switch yields one durable visible event.
    3. Keep the hidden recovery marker durable but suppress it from live transcript rendering, child replay, search, and restart UI. Suppression must match the exact internal custom type, not broad custom-role filtering.
    4. Register the read-only primary renderer and map the strict event into child native overlay, replay steps, ANSI-free search, and restart reconstruction.
    5. Use only shared row/paint/clip primitives. Port the measured degradation from Task 8 exactly.
    6. Replace configured-model card facts with one strict applied identity atom `{ provider, id, name? }`. Bump the card facts schema. Parse older durable cards truthfully; unknown applied identity renders `—`.
    7. Apply authenticated child `applied` facts as one atomic card-model update. Apply `recovery-confirmed` once to the existing Native Line, such as `↪ model fallback · <destination>`, without adding chrome.
    8. Implement the pure bounded display-name formatter for the bold Title Case frame title, including the closed initialism set recorded by the design.
    9. Keep elapsed output in the footer only and preserve the blank third rail/body pair across queued, running, completed, failed, and cancelled states.
  - **Pitfalls / non-goals**:
    - The visible event is not an operational database or standalone file. Pi native session history is the durable source.
    - Do not derive actual applied identity from configured intent after startup.
    - Do not suppress unrelated custom messages from replay or search.
  - **Acceptance**:
    - One confirmed switch renders exactly one identical Model Fallback event live, after replay, in search, and after restart.
    - The failed assistant and hidden marker remain in native history; the marker is absent from visible/search surfaces.
    - Applied-only switch updates the card's provider/model truth but creates no visible fallback event or Native Line claim.
    - Card snapshot tests match the exact wide geometry and every measured narrow band, including footer-only elapsed and blank third row.
    - Old card facts parse without inventing an applied model.

- [ ] 10. Close cross-mode, race, security, and boundedness coverage
  - **What**: Exercise one implementation across primary, delegated, direct-step, and nested modes, including every no-settlement host error and race.
  - **Files**: `packages/adapters/pi/src/__tests__/extension.test.ts`, `packages/adapters/pi/src/__tests__/child-mode.test.ts`, `packages/adapters/pi/src/__tests__/direct-dispatch.test.ts`, `packages/adapters/pi/src/__tests__/direct-dispatch-transport.test.ts`, `packages/adapters/pi/src/__tests__/delegation-controller.test.ts`, `packages/adapters/pi/src/__tests__/rpc-child-settlement-race.test.ts`, `packages/adapters/pi/src/__tests__/child-historical-overlay-restart.test.ts`, `packages/adapters/pi/src/__tests__/child-overlay-internal-entry-suppression.test.ts`, `packages/adapters/pi/src/__tests__/child-overlay-prototype-parity.test.ts`, `packages/adapters/pi/src/__tests__/child-overlay-render-width.test.ts`, `packages/adapters/pi/src/__tests__/weave-ui-accessibility.test.ts`.
  - **Depends on**: Tasks 7–9.
  - **Implementation outline**:
    1. Run the same failure/switch/recovery matrix for primary, delegated, direct-step, and nested sessions.
    2. Cover `setModel(false)`, synchronous throw, promise rejection, timeout, catalog miss, auth-unavailable preflight, no matching `model_select`, and no marker start. Assert the coordinator does not wait for a Pi settlement these paths cannot emit.
    3. Race real queued input and pending work before, during, and after model application. Assert no real message is filtered or mistaken for the marker.
    4. Race unmatched, delayed, duplicate, and ambiguous `model_select` events. Assert manual override latches until explicit Weave activation.
    5. Race generation/session reset, reload, shutdown, parent cancellation, local timeout, child settlement, and late context delivery.
    6. Verify provider-fast state resets or recomputes for each applied candidate and never keeps the prior provider's acceleration claim.
    7. Verify all marker, message, entry, control-body, candidate-count, timer, replay-step, and renderer-width bounds at and beyond their limits.
  - **Pitfalls / non-goals**:
    - Do not rely on sleeps where a fake clock or explicit deferred host action can prove order.
    - Do not weaken current child authentication or settlement race tests to fit recovery.
  - **Acceptance**:
    - Every mode keeps the same PID/session/thread/tool-call identity in its integration model and settles once.
    - Concurrent real messages remain intact and force a safe stop where required.
    - No stale callback, duplicate control body, replayed entry, or delayed host event creates a second event or settlement.
    - Security tests prove no raw errors, credentials, marker tokens, or failed content reach UI, telemetry, child control, or sanitized diagnostics.

- [ ] 11. Update current capability, model, adapter, security, and smoke documentation
  - **What**: Remove obsolete design material and document the public Pi 0.84.2 behavior, optional compatibility policy, lifecycle compromise, trust boundary, and UI contract.
  - **Files**: delete `docs/specs/33-spec-pi-adapter/33-post-recovery-hook-design.md`; update `docs/adapters/pi.md`, `docs/reference/models.md`, `docs/reference/adapter-capabilities.md`, `docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md`, `docs/specs/33-spec-pi-adapter/33-threat-model.md`, `docs/specs/33-spec-pi-adapter/33-smoke-checklist.md`, `packages/docs/src/content/docs/docs/reference/adapters/pi.mdx`, `packages/docs/src/content/docs/docs/prompts-models-policy.mdx`, and any exact links found by `rg`.
  - **Depends on**: Tasks 3–10.
  - **Implementation outline**:
    1. Describe the two-low-level-run compromise exactly: Pi settles internally first; Weave keeps its visible child/tool/session pending and starts recovery with a hidden public custom-message turn.
    2. State that recovery uses the same process and native session, skips `before_agent_start`, and requires exact marker observation plus timeout.
    3. Document provider-only context repair, durable failed-attempt history, no synthetic provider user message, and no output concatenation.
    4. Document optional capability behavior: Pi 0.84.2 is exact-tested; lower or unproven hosts keep the existing floor and legacy settlement, with no health-only change.
    5. Document manual override, bounded candidate selection, context-window rule, auth/catalog skip behavior, and truthful applied-model reporting.
    6. Document trusted context-handler composition and the explicit lack of isolation from a malicious full-access extension.
    7. Document the read-only event and normative card geometry by linking the existing UI design record rather than duplicating it.
    8. Remove every stale capability name, event claim, host dependency, and obsolete design link.
  - **Pitfalls / non-goals**:
    - Do not add a numbered implementation spec or committed proof checklist tied only to this issue.
    - Do not claim exact behavior on a host not proven by Task 15.
  - **Acceptance**:
    - Repository search finds no stale lifecycle/capability references or links to the deleted design file.
    - Current and public docs agree on public surfaces, optional degradation, exact-tested Pi 0.84.2, and the lifecycle compromise.
    - `bun run docs:check-links` passes.

- [ ] 12. Add repeatable Pi 0.84.2 release smoke tooling
  - **What**: Add a bounded release script that drives the exact packed adapter through a real Pi 0.84.2 TUI and captures sanitized proof facts.
  - **Files**: `scripts/release/pi-model-failover-smoke.ts` (new), `scripts/release/__tests__/pi-model-failover-smoke.test.ts` (new), `scripts/release/pi-acceptance/smoke-checklist.md`, `scripts/release/acceptance-manifest-data.ts`, existing release harness helpers discovered beside `scripts/release/pi-child-inspection-smoke.ts`.
  - **Depends on**: Tasks 7–11.
  - **Implementation outline**:
    1. Follow the existing isolated-home, packed-artifact, strict-provenance, bounded-timeout, cleanup, and sanitized-report conventions.
    2. Require exact Pi version 0.84.2 and fail closed on version or artifact hash mismatch.
    3. Use a deterministic local provider fixture to fail the first candidate and capture the fallback provider request without writing raw bodies to the durable report.
    4. Assert provider-context facts: original user/task/tool history present; exact failed assistant and marker absent; durable native history retains both; no synthetic provider-level user message exists.
    5. Capture stable process/session/thread/tool-call identities, visible event count, card applied identity, Native Line, parent tool pending interval, settlement count, and cleanup facts.
    6. Emit only bounded booleans, hashes, safe identities, counts, versions, and sanitized diagnostics to an ephemeral report path.
    7. Provide a rollback case that disables one optional surface and proves legacy settlement without health-only mode.
  - **Pitfalls / non-goals**:
    - Do not commit proof output or create standalone runtime state.
    - Do not use the developer's active Pi home, session, or credentials.
    - Do not let a local fixture make the lifecycle assertions pass without real Pi events.
  - **Acceptance**:
    - Unit tests cover command construction, timeouts, cleanup on every exit, redaction, report bounds, and negative assertions.
    - The script refuses the wrong Pi version, unpacked source, altered artifact, unexpected event count, or leaked marker/provider content.
    - Acceptance manifest and smoke checklist include the new case with no issue-specific proof file.

- [ ] 13. Run focused and repository-wide verification
  - **What**: Validate the complete implementation before freezing a review range.
  - **Files**: No new files unless a failing test exposes a required in-scope correction.
  - **Depends on**: Tasks 1–12.
  - **Implementation outline**:
    1. Run focused fallback, context, coordinator, settlement, protocol, card, overlay, capability, and release-script tests.
    2. Run the full Pi adapter suite.
    3. Run root tests, typecheck, lint, build, config validation, and docs link checks.
    4. Run host singleton verification and declaration validation.
    5. Confirm `git status` contains only intended issue files and no durable proof report, provider capture, credentials, generated home, or packed artifact.
    6. Record the exact commit range and artifact source commit for review.
  - **Pitfalls / non-goals**:
    - Do not waive unrelated-looking failures without proving they predate the range.
    - Keep fixes focused and rerun the affected full gate.
  - **Acceptance**:
    - All commands in `## Verification` pass.
    - The worktree is free of generated operational/proof data.
    - The review range is exact and reproducible.

- [ ] 14. Obtain Weft approval on the frozen implementation range
  - **What**: Review the exact frozen range for architecture, public Pi API use, bounds, failure handling, child authentication, and test adequacy before live execution.
  - **Files**: No planned production edits. Review findings may require focused fixes and a new frozen range.
  - **Depends on**: Task 13.
  - **Implementation outline**:
    1. Give Weft the plan, exact range, Pi adapter rules, public-surface inventory, coordinator state table, context-repair invariants, and verification results.
    2. Require explicit review of no private imports, no synthetic provider user message, no process/session replacement, no standalone durable data, and optional capability honesty.
    3. Require explicit review of marker ambiguity, manual override races, setModel no-settlement cases, trusted-handler assumptions, and exactly-once child settlement.
    4. Fix every blocker, rerun Task 13, and obtain approval on the new exact range.
  - **Pitfalls / non-goals**:
    - A review of an earlier range does not approve later fixes.
  - **Acceptance**:
    - Weft returns approval for the exact range used to build the Task 15 artifact.

- [ ] 15. Prove the reviewed artifact on real installed Pi 0.84.2
  - **What**: Run the release smoke against the exact reviewed packed adapter and collect ephemeral evidence of the real public lifecycle.
  - **Files**: No committed files. Use a temporary isolated Pi home, temporary packed artifact location, and temporary sanitized report directory.
  - **Depends on**: Task 14.
  - **Implementation outline**:
    1. Build and hash the adapter from the Weft-approved source commit. Load it through normal strict package provenance in an isolated Pi home.
    2. Verify Pi reports exactly 0.84.2 and run `bun run verify:pi-host-singleton` before the scenario.
    3. Start one child whose first model emits a terminal failed partial assistant after Pi's native recovery paths and whose next eligible model succeeds.
    4. Observe exact marker `message_start`, exact context repair, and the new low-level run. Confirm `before_agent_start` does not run for recovery.
    5. Prove the child PID, native session ID, thread ID, and parent tool-call ID are unchanged. Prove the parent tool remains pending throughout.
    6. Inspect the deterministic provider capture: original user/task/tool history is present; failed assistant and marker are absent; no synthetic provider-level user message exists.
    7. Inspect native durable history: failed assistant and marker remain, successful assistant is separate, and one strict visible fallback entry exists.
    8. Confirm exactly one visible Model Fallback event, the authenticated card provider/model update, the expected Native Line, and the approved wide/narrow geometry.
    9. Confirm one final settlement and cleanup: no child process, active lease, temporary pane, or leaked fixture process remains.
    10. Run the optional-surface-disabled rollback case and confirm legacy settlement with ready health.
  - **Pitfalls / non-goals**:
    - Do not use a different build after Weft approval.
    - Keep raw request bodies, credentials, marker tokens, and assistant content outside the report.
  - **Acceptance**:
    - All listed identity, context, durable-history, UI, settlement, and cleanup assertions pass on real Pi 0.84.2.
    - The report records only sanitized bounded facts and stays outside the repository.
    - Exact-tested-host documentation is now backed by this run.

- [ ] 16. Obtain mandatory Warp approval on the exact live-proven range
  - **What**: Perform final conformance review after live proof, including the proof's identity and provider-context assertions.
  - **Files**: No planned edits. Any blocker restarts the affected verification, Weft review if the implementation range changes, artifact build, live proof, and Warp review.
  - **Depends on**: Task 15.
  - **Implementation outline**:
    1. Give Warp the plan, exact source range, artifact hash, Weft verdict, sanitized live report, and command results.
    2. Require explicit checks against every scope exclusion and every acceptance item in Tasks 7, 9, 10, and 15.
    3. Require confirmation that docs state the low-level-run compromise and optional host policy honestly.
    4. Resolve all blockers and repeat the required gates on the new exact range.
  - **Pitfalls / non-goals**:
    - Do not treat a mock-only pass or stale artifact as live conformance.
  - **Acceptance**:
    - Warp returns approval for the exact source and artifact proven on Pi 0.84.2.

- [ ] 17. Deliver and verify rollback
  - **What**: Finalize focused commits, preserve the prior approved adapter artifact, and document a reversible installation path.
  - **Files**: Issue-linked commit history and existing release metadata only. No committed proof output.
  - **Depends on**: Task 16.
  - **Implementation outline**:
    1. Keep commits focused and Conventional, with the Weave issue reference.
    2. Preserve the previously approved adapter artifact and its hashes before installing the new one.
    3. Install the exact Warp-approved artifact through the project's normal local Pi development/release path, then restart Pi so the loaded code is unambiguous.
    4. Run a short ready/health check and one nonfailure delegation smoke after installation.
    5. Test rollback by restoring the prior artifact/config, restarting Pi, and confirming legacy behavior and ready health. Restore the approved new artifact only after rollback proof completes.
    6. Leave no active lease, child process, temporary home, pane, provider fixture, or proof file.
  - **Pitfalls / non-goals**:
    - Do not overwrite the only rollback artifact.
    - Do not claim a running Pi process loaded a newly installed artifact without restart proof.
  - **Acceptance**:
    - The installed artifact hash matches the Warp-approved live-proven artifact.
    - New-install smoke and rollback smoke both pass.
    - Repository and local runtime cleanup checks pass.

## Verification

Run focused checks as implementation lands, then run the complete gate from the repository root:

```bash
# Focused pure/coordinator/context tests
bun test \
  packages/adapters/pi/src/__tests__/model-failover-contract.test.ts \
  packages/adapters/pi/src/__tests__/model-failover-context.test.ts \
  packages/adapters/pi/src/__tests__/model-failover-coordinator.test.ts \
  packages/adapters/pi/src/__tests__/model-failover-preflight.test.ts

# Focused lifecycle, settlement, protocol, and provider-context tests
bun test \
  packages/adapters/pi/src/__tests__/model-failover-context.integration.test.ts \
  packages/adapters/pi/src/__tests__/model-failover-lifecycle.integration.test.ts \
  packages/adapters/pi/src/__tests__/child-compaction-settlement.test.ts \
  packages/adapters/pi/src/__tests__/rpc-child-settlement-race.test.ts \
  packages/adapters/pi/src/__tests__/child-mode.test.ts \
  packages/adapters/pi/src/__tests__/direct-dispatch.test.ts \
  packages/adapters/pi/src/__tests__/delegation-controller.test.ts

# Focused UI, persistence, compatibility, and smoke-script tests
bun test \
  packages/adapters/pi/src/__tests__/model-failover-record.test.ts \
  packages/adapters/pi/src/__tests__/model-fallback-event-render.test.ts \
  packages/adapters/pi/src/__tests__/child-card-model.test.ts \
  packages/adapters/pi/src/__tests__/child-card-render.test.ts \
  packages/adapters/pi/src/__tests__/child-historical-overlay-restart.test.ts \
  packages/adapters/pi/src/__tests__/child-overlay-prototype-parity.test.ts \
  packages/adapters/pi/src/__tests__/weave-ui-accessibility.test.ts \
  packages/adapters/pi/src/__tests__/capability-prober.test.ts \
  packages/adapters/pi/src/__tests__/host-compatibility-matrix.test.ts \
  scripts/release/__tests__/pi-model-failover-smoke.test.ts

# Full project gates
bun test
bun run typecheck
bun run lint
bun run build
bun run validate-config
bun run docs:check-links
bun run verify:pi-host-singleton
```

Run the live proof only after Weft approval, using the exact reviewed artifact and an ephemeral report path:

```bash
bun scripts/release/pi-model-failover-smoke.ts \
  --artifact /absolute/path/to/reviewed-weave-adapter-pi.tgz \
  --expected-pi-version 0.84.2 \
  --case all \
  --report /private/tmp/weave-pi-model-fallback-proof/report.json
```

The final proof must establish all of these facts:

- Pi version is exactly 0.84.2 and the adapter hash matches the reviewed artifact.
- Pi completes its own recovery and emits its low-level settlement before Weave fallback.
- The exact hidden marker's `message_start` proves dispatch within the bound.
- The recovery run uses the same child PID, native session ID, thread ID, and parent tool-call ID.
- `before_agent_start` does not run for recovery.
- Provider context keeps all real user/task/tool/steering/follow-up history and removes only the exact failed assistant and marker.
- Native history keeps both removed entries, and successful fallback output is separate.
- No synthetic provider-level user message exists.
- Exactly one visible Model Fallback event appears for the confirmed switch.
- The card shows the authenticated applied provider/model in the approved geometry and updates the Native Line only after recovery confirmation.
- The parent tool remains pending until one final settlement.
- Cleanup leaves no child process, lease, temporary pane, provider fixture, or committed proof data.
