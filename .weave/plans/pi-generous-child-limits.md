# Pi Generous Child Limits

## TL;DR
Replace arbitrary child-failing Weave limits with loose fault-containment ceilings and graceful, bounded data paths. Preserve authoritative task and result data through chunking, paging, backpressure, and Runtime Store persistence; truncate only non-authoritative display text.

## Context and evidence
- [user] Keep Weave constraints, but make them as loose as practical. Prefer chunking, Runtime Store persistence, paging, bounded projection, warning, truncation of non-authoritative display text, or backpressure over child failure.
- [user] Never truncate authoritative task or result data. Focus only on Weave-imposed limits.
- [user] Retain strict parser, framing, aggregate-transfer, concurrent-transfer, allocation, and process ceilings; measure payload limits in UTF-8 bytes where practical.
- [user] `packages/adapters/pi/src/delegation-controller.ts` and `packages/adapters/pi/src/delegation-tool.ts` currently impose an 8,192-character task/retry cap and a cumulative `maxRuns` of 1,000.
- [user] `packages/adapters/pi/src/errors.ts`, `packages/adapters/pi/src/child-envelope.ts`, `packages/adapters/pi/src/child-transfer.ts`, and `packages/adapters/pi/src/prompt-chunking.ts` impose an 8 MiB JSONL frame ceiling, 64 KiB control-body ceiling, 24 KiB chunk size, 64 MiB aggregate-transfer ceiling, and 32-transfer concurrency ceiling; chunking already exists.
- [user] `packages/adapters/pi/src/child-control-bodies.ts` limits failure reasons to 8,192 characters, settlement output to 4 KiB, protocol reasons to 2,000 characters, and target catalogs to 9 entries.
- [user] `packages/adapters/pi/src/child-tree.ts`, `packages/adapters/pi/src/rpc-child.ts`, `packages/adapters/pi/src/artifact-provider.ts`, and `packages/adapters/pi/src/child-recovery.ts` constrain authoritative or parent-visible output to 4 KiB, as well as previews.
- [user] `packages/core/src/schema.ts` and `packages/engine/src/delegation-limits.ts` set child count default/max to 9, concurrency default 3/max 9, depth 3, and processes 9.
- [user] `packages/adapters/pi/src/child-timer.ts` sets handshake to 10 seconds, reply to 15 seconds, inactivity to 15 minutes, and runtime to 60 minutes.
- [user] `packages/adapters/pi/src/child-transcript.ts`, `packages/adapters/pi/src/child-session-checkpoint.ts`, and `packages/adapters/pi/src/child-native-sessions.ts` already use bounded memory/read paths and paging.
- [user] `packages/adapters/pi/src/structured-completion.ts` limits completion messages to 4,096 characters and artifacts to 32.
- [user] Durable operational data must live in the Runtime Store/database and be exposed by bounded CLI queries, not standalone files.
- [repo: docs/architecture/adapter-boundary.md#Ownership matrix] Core/config/engine own portable delegation budgets; the Pi adapter owns live queues, process counts, transport, private child state, quotas, persistence, and recovery. Runtime Store mutation remains engine-owned.
- [repo: docs/architecture/adapter-boundary.md#Safe metadata] Data crossing the engine/adapter boundary must use closed, bounded shapes and must not expose raw private transcripts or harness payloads.
- [repo: docs/contributing/typescript.md] Expected failures use typed `Result`/`ResultAsync` values from `neverthrow`, not throws or `console.*`.
- [repo: docs/contributing/testing.md] Schema changes require tests in the same commit, and package/process boundaries require isolated mocks.
- [repo: docs/testing/adapter-verification.md#Required proof] Pi adapter changes need exact-artifact build/install proof, a fresh interactive Pi process, readiness checks, real delegation behavior, settlement, and cleanup evidence.
- [repo: package.json#scripts] Repository verification uses Bun: `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`, and `bun run docs:check-links`.

## Scope
- In scope:
  - [user] Weave-imposed Pi delegated-child limits listed in this plan, their units, error behavior, configuration, projections, persistence, queries, warnings, tests, and documentation.
  - [user] Loose fault-containment ceilings that reject malformed, abusive, or resource-exhausting input without rejecting ordinary long-running or high-output child work.
  - [user] Protocol/schema migration and compatibility analysis for any changed wire shape or persisted Runtime Store shape.
- Out of scope:
  - [user] Pi-, OS-, provider-, model-, or third-party-imposed limits that Weave does not control.
  - [user] Removing parser/framing/allocation/process safety boundaries or making transport/persistence reads unbounded.
  - [repo: docs/architecture/adapter-boundary.md#Runtime state] Moving Pi private transcripts, raw events, or harness-owned session paths into engine APIs.
  - [user] Standalone output/history files outside the Runtime Store database.
- Constraints:
  - [user] Never truncate authoritative task or result data.
  - [user] Truncation is allowed only for explicitly non-authoritative display or diagnostic projections, with an unambiguous truncation marker and a bounded way to retrieve durable full data when such data is retained.
  - [user] Prefer UTF-8 byte limits over JavaScript character-count limits.
  - [repo: docs/architecture/adapter-boundary.md#Ownership matrix] Keep portable budget semantics in core/engine and Pi transport, UI, quotas, and recovery in the adapter.
  - [repo: docs/contributing/typescript.md] Preserve typed `neverthrow` failures for expected limit, storage, paging, and protocol failures.

## Limit decision table

| Limit | Current | Decision | Proposed treatment |
| --- | ---: | --- | --- |
| Delegated task/retry text | 8,192 characters | Remove as a child-failing limit | [proposed] Carry the full authoritative task through existing chunked transfer. Apply only the retained frame/aggregate/allocation ceilings in UTF-8 bytes. If backpressure cannot make progress, return a typed transport/resource failure without truncating the task. |
| Cumulative `maxRuns` | 1,000 | Remove or replace | [proposed] Remove the lifetime cumulative counter. If abuse control still needs a run limit, replace it with a configurable rolling-window/rate budget that waits or warns before rejection; do not count settled historical runs against future capacity. |
| JSONL frame/parser ceiling | 8 MiB | Keep strict | [user] Keep as a framing/allocation boundary, measured in UTF-8 bytes, with typed failure before oversized allocation or parse work. |
| Control body | 64 KiB | Keep strict | [user] Keep as a protocol/allocation ceiling in UTF-8 bytes. Route large authoritative data by reference/chunk transfer instead of enlarging the control body without bound. |
| Transfer chunk | 24 KiB | Keep strict | [user] Keep bounded chunks and use backpressure. Confirm encoded bytes, envelope overhead, and receiver allocation remain below the framing ceiling. |
| Aggregate transfer | 64 MiB | Keep strict | [user] Keep as an allocation/fault-containment ceiling. [proposed] Make it configurable only within a documented generous hard maximum; authoritative payloads beyond the configured transfer budget must use durable paging/reference, never truncation. |
| Concurrent transfers | 32 | Keep strict | [user] Keep the ceiling. Queue/backpressure excess transfers rather than fail healthy children unless queue capacity or shutdown makes progress impossible. |
| Failure reason | 8,192 characters | Graceful degradation | [proposed] Treat it as non-authoritative diagnostic display. Normalize to a user-approved UTF-8 byte cap, preserve typed code and structured metadata, append a truncation marker, and retain/query fuller diagnostic detail only if current privacy and Runtime Store contracts permit it. |
| Settlement output | 4 KiB | Remove as an authoritative-data cap | [proposed] Persist or reuse durable full output/history, settle with a stable reference plus a bounded inline projection, and fetch by bounded pages. Never truncate the stored authoritative result. |
| Protocol reason | 2,000 characters | Graceful degradation | [proposed] Keep a bounded diagnostic field in UTF-8 bytes, preserve typed protocol code, and truncate only display text with a marker. |
| Target catalog | 9 entries | Loosen/configure or page | [proposed] Separate visible page size from total target eligibility. Page/filter a bounded catalog; do not hide valid targets merely because more than nine exist. Keep a configurable total catalog ceiling to bound allocation. |
| Parent/tree/RPC/recovery/artifact output | 4 KiB | Graceful degradation | [proposed] Replace authoritative truncation with a stable full-result reference and bounded inline projection. Keep previews bounded and clearly non-authoritative. |
| Child count | default/max 9 | Loosen/configure | [proposed] Retain a finite portable budget but raise the hard maximum after process/memory tests; keep a conservative configurable default. Settled children must not consume active capacity. |
| Concurrent children | default 3/max 9 | Loosen/configure | [proposed] Retain a finite active-concurrency ceiling; queue/backpressure above it rather than reject. Raise the hard maximum only with real Pi resource evidence. |
| Delegation depth | 3 | Loosen/configure | [proposed] Keep finite and configurable, with a larger hard maximum only if cycle/ancestry and total-process controls remain strict. |
| Processes | 9 | Keep strict, optionally loosen | [user] Retain a strict process ceiling. [proposed] Make the configured value independently tunable up to a tested hard maximum; queue child starts when capacity can later free. |
| Handshake timeout | 10 seconds | Loosen/configure | [proposed] Raise defaults and expose bounded configuration; preserve typed timeout and cancellation. Candidate default: 30 seconds. |
| Reply timeout | 15 seconds | Loosen/configure | [proposed] Treat parser-approved activity as progress and expose a bounded setting. Candidate default: 60 seconds. |
| Inactivity timeout | 15 minutes | Loosen/configure | [proposed] Preserve renewable inactivity semantics; candidate default: 60 minutes, with a finite approved maximum. |
| Runtime timeout | 60 minutes | Loosen/configure | [proposed] Candidate default: 6 hours, with a finite approved maximum and explicit cancellation/cleanup. |
| Transcript/checkpoint/native-session reads | bounded and paged | Keep strict | [user] Preserve bounded pages, memory, and read steps. Increase page budgets only from evidence; return continuation rather than silently losing authoritative history. |
| Structured completion message | 4,096 characters | Graceful degradation | [proposed] Make the message a bounded inline projection (candidate 32–64 KiB UTF-8) backed by the authoritative full result/reference when longer. |
| Structured completion artifacts | 32 | Loosen/configure or page | [proposed] Preserve every authoritative artifact reference in durable/paged form; limit only each inline page/projection. Keep a finite total catalog ceiling if needed for allocation safety. |

## Decisions needed before execution
- [proposed] Choose the inline result projection cap: **32 KiB or 64 KiB UTF-8**. This affects control-body headroom, UI cost, compatibility, and how often users must page full results.
- [proposed] Choose new child and concurrency defaults/hard maxima. A candidate starting point for measurement is `max_children` default 32/hard max 256, active concurrency default 8/hard max 64, depth default 8/hard max 32, and processes default 32/hard max 128. Approval is required because these values change resource exposure and portable DSL validation.
- [proposed] Choose timeout defaults/hard maxima. Candidate defaults are handshake 30 seconds, reply 60 seconds, renewable inactivity 60 minutes, and runtime 6 hours; candidate hard maxima are handshake 5 minutes, reply 15 minutes, inactivity 24 hours, and runtime 7 days. Approval is required because these change failure timing and resource retention.
- [proposed] Choose one UTF-8 diagnostic-text cap for failure/protocol display text. Candidate: 32 KiB, with typed codes always preserved. Approval is required because larger diagnostics increase transport/log/UI exposure.
- [proposed] Choose target catalog page size and total ceiling. Candidate: 64 entries per page and 4,096 total eligible targets, with filter/search before projection. Approval is required because catalog size affects memory and UI behavior.
- [proposed] Decide whether to remove cumulative `maxRuns` with no replacement or replace it with a rolling-window/rate budget. Recommended: remove the cumulative limit first; add a rate budget only if evidence shows a fault-containment need. This changes authorization/runtime behavior.
- [proposed] Decide whether aggregate-transfer size remains fixed at 64 MiB or becomes configurable under a hard maximum. Recommended: keep 64 MiB as the direct-transfer ceiling and route larger authoritative data through durable paged references. This controls memory risk without imposing a result-size cap.

## Open questions and assumptions
- Open question: Does the current Runtime Store and bounded CLI already preserve and query complete child output/history, or only execution metadata and bounded observations? This determines whether Tasks 3–5 reuse existing APIs or require schema/repository/CLI work.
- Open question: Which current 4 KiB fields are protocol-authoritative values versus UI previews derived from authoritative child session history? This affects the compatibility strategy and must be classified before editing wire shapes.
- Open question: Can target discovery already filter/page before materializing the full catalog? This affects whether only UI projection changes or the target-discovery port must change.
- Open question: Does `maxRuns` protect one invocation, one controller lifetime, one session, or durable history, and what cleanup currently resets it? Task 2 must answer this before removal/replacement.
- Assumption: Existing chunk-transfer identity, integrity, framing, and aggregate checks can carry full task text without a new transport. This is reversible; Task 2 must prove it before implementation.
- Assumption: Existing native child-session paging remains the authoritative history source unless Task 3 proves that durable full result retrieval requires a Runtime Store record. This avoids premature engine persistence APIs and affects Tasks 4–5.

## Objectives
- Remove preventable failures caused by small task, result, catalog, count, and time limits.
- Preserve strict, byte-based fault-containment at parser, frame, transfer, allocation, and process boundaries.
- Preserve full authoritative task/result data while exposing bounded projections and paged queries.
- Keep limit ownership and persistence APIs on the correct side of the engine/Pi adapter boundary.
- Prove the final behavior in isolated tests and a fresh real Pi process.

## Dependencies and order
1. Freeze approved values and classify each field as authoritative, reference, projection, or diagnostic before changing schemas or protocol.
2. Remove task/run failures and add queue/backpressure only after confirming current chunking and lifecycle-counter semantics.
3. Verify current durable output/history support before designing any Runtime Store schema, repository, or CLI API.
4. Implement full-result storage/reference/query before replacing authoritative 4 KiB fields with bounded projections.
5. Change portable child/depth/concurrency limits before final Pi queue/process tests, because adapter behavior must enforce the normalized engine budget.
6. Apply protocol/schema migrations with compatibility tests before live Pi verification.
7. Run focused and workspace verification before exact-artifact real-harness proof.

## Tasks

- [x] 1. Approve the limit policy and establish shared byte/projection semantics
  - **What**: Resolve every proposed value above; define exact terms for authoritative data, display projection, diagnostic text, UTF-8 byte measurement, truncation marker, continuation token/reference, queue backpressure, and hard ceiling.
  - **Files**: `docs/adapters/pi.md`, `docs/reference/dsl.md`, `docs/reference/runtime.md`, `docs/architecture/adapter-boundary.md` (only if the existing ownership text needs clarification).
  - **Depends on**: User approval of **Decisions needed before execution**.
  - **Implementation outline**:
    1. Record the approved defaults, configurable ranges, and immutable hard ceilings.
    2. State which fields may truncate and which must survive byte-for-byte as authoritative task/result data.
    3. Define whether configuration is DSL-level portable intent, Pi adapter setting, or internal fixed protocol safety.
  - **Pitfalls / non-goals**:
    - Do not turn transport internals such as frame size into portable DSL unless more than one adapter needs the same intent.
    - Do not describe projections as complete results.
  - **Acceptance**:
    - [user] Every listed limit has one approved disposition: remove, keep, loosen/configure, or graceful degradation.
    - [user] All payload units use UTF-8 bytes unless a documented non-payload count is intentional.
    - [repo: docs/architecture/adapter-boundary.md#Ownership matrix] Portable budgets stay in core/engine; Pi wire, process, UI, and persistence mechanics stay in the adapter.

- [x] 2. Remove small task/retry failures and replace cumulative run exhaustion with progress-aware control
  - **What**: Let authoritative delegated tasks/retries use the existing chunked path; remove the 8,192-character rejection; remove or replace cumulative `maxRuns` as approved; queue work where active capacity can free.
  - **Files**: `packages/adapters/pi/src/delegation-controller.ts`, `packages/adapters/pi/src/delegation-tool.ts`, `packages/adapters/pi/src/prompt-chunking.ts`, `packages/adapters/pi/src/child-transfer.ts`, `packages/adapters/pi/src/errors.ts`, `packages/adapters/pi/src/__tests__/delegation-controller.test.ts`, `packages/adapters/pi/src/__tests__/delegation-tool.test.ts`, `packages/adapters/pi/src/__tests__/child-transfer.test.ts`.
  - **Depends on**: Task 1.
  - **Implementation outline**:
    1. Trace task/retry encoding through chunking and prove limits include UTF-8 bytes and envelope overhead.
    2. Delete character-count rejection and retain typed frame, aggregate, allocation, cancellation, and shutdown failures.
    3. Replace cumulative historical run accounting with the approved no-limit or rolling/rate policy; ensure settled children release active capacity.
    4. Add bounded queue/backpressure with cancellation and fairness tests where a slot can later free.
  - **Pitfalls / non-goals**:
    - Never truncate or summarize the authoritative task to fit a control body.
    - Do not retry forever when transport makes no progress or shutdown begins.
  - **Acceptance**:
    - [user] A task and retry larger than 8,192 characters, including multibyte UTF-8, reaches the child unchanged when below retained byte/allocation ceilings.
    - [user] Historical settled runs do not cause a healthy later child to fail solely because 1,000 prior runs occurred.
    - [user] Parser, frame, aggregate-transfer, concurrent-transfer, and allocation limits still fail with typed errors at their exact byte boundaries.
    - [repo: docs/contributing/typescript.md] Expected failures return typed `Result`/`ResultAsync` values.

- [x] 3. Verify existing durable full-output and history query support before adding persistence APIs
  - **What**: Establish whether native session history, Runtime Store records, and current CLI commands already provide complete durable child result/history retrieval with bounded pages.
  - **Files**: `packages/adapters/pi/src/child-transcript.ts`, `packages/adapters/pi/src/child-session-checkpoint.ts`, `packages/adapters/pi/src/child-native-sessions.ts`, `packages/adapters/pi/src/runtime-store-port.ts`, `packages/engine/src/runtime/store.ts`, `packages/engine/src/runtime/types.ts`, `packages/engine/src/runtime/sqlite/schema.ts`, `packages/engine/src/runtime/sqlite/migrations.ts`, `packages/engine/src/runtime/sqlite/store.ts`, `packages/cli/src/commands/runtime.ts`, `docs/reference/runtime.md`, `docs/adapters/pi.md`.
  - **Depends on**: Task 1.
  - **Implementation outline**:
    1. Trace write ownership, authoritative source, retention, restart recovery, and query paths for full child output and history.
    2. Prove whether queries are bounded by page size/read steps and expose stable continuation without duplicate/omitted records.
    3. Produce a file-backed decision in the implementation change: reuse the current path, extend it, or add the minimum new Runtime Store API.
  - **Pitfalls / non-goals**:
    - Do not add a database table, repository method, or CLI command until this task proves a gap.
    - Do not move raw Pi transcripts or session paths across the engine boundary.
  - **Acceptance**:
    - [user] The implementation records clear proof of whether durable complete output/history can already be retrieved after restart through bounded queries.
    - [repo: docs/architecture/adapter-boundary.md#Runtime state] Any proposed engine API contains only bounded normalized data or opaque safe references, not Pi paths, raw events, or private transcripts.
    - [user] No standalone file persistence is introduced.

- [x] 4. Add the minimum durable full-result/reference model only if Task 3 proves a gap
  - **What**: Preserve complete authoritative child results in the Runtime Store database and expose stable bounded retrieval, but only for data not already durably queryable through the approved existing source.
  - **Files**: `packages/engine/src/runtime/types.ts`, `packages/engine/src/runtime/store.ts`, `packages/engine/src/runtime/memory-store.ts`, `packages/engine/src/runtime/sqlite/schema.ts`, `packages/engine/src/runtime/sqlite/migrations.ts`, `packages/engine/src/runtime/sqlite/store.ts`, `packages/adapters/pi/src/runtime-store-port.ts`, `packages/engine/src/__tests__/runtime-contract.test.ts`, `packages/engine/src/__tests__/runtime-memory.test.ts`, `packages/engine/src/__tests__/runtime-sqlite.test.ts`.
  - **Depends on**: Task 3 proves a persistence/query gap.
  - **Implementation outline**:
    1. Define an engine-owned, harness-neutral record/reference and paged query contract with retention and size accounting.
    2. Store full authoritative bytes or normalized chunks transactionally; expose bounded pages and stable continuation/order.
    3. Add an append-only or versioned SQLite migration and keep memory/SQLite stores contract-equivalent.
    4. Map quota, corruption, migration, and query failures to typed errors without partial-success ambiguity.
  - **Pitfalls / non-goals**:
    - Avoid duplicate durable copies when Pi native session history is already authoritative and safely queryable.
    - Never place raw harness paths, credentials, provider payloads, or unbounded metadata in Runtime Store records.
  - **Acceptance**:
    - [user] Full authoritative result data survives restart and can be reconstructed exactly through bounded pages without standalone files.
    - [repo: docs/contributing/testing.md#Module isolation] Runtime Store implementations pass the shared contract against isolated memory and SQLite fixtures.
    - [repo: docs/architecture/adapter-boundary.md#Runtime state] The adapter calls narrow engine APIs and never receives a database mutation surface.
    - [user] Migration from every supported prior schema preserves existing runtime records or fails closed with a typed migration error.

- [x] 5. Replace authoritative 4 KiB result caps with references and bounded inline projections
  - **What**: Carry complete settlement/results by durable reference or existing paged history while rendering only the approved 32–64 KiB inline projection; keep previews explicitly non-authoritative.
  - **Files**: `packages/adapters/pi/src/child-control-bodies.ts`, `packages/adapters/pi/src/child-tree.ts`, `packages/adapters/pi/src/rpc-child.ts`, `packages/adapters/pi/src/artifact-provider.ts`, `packages/adapters/pi/src/child-recovery.ts`, `packages/adapters/pi/src/structured-completion.ts`, `packages/adapters/pi/src/__tests__/child-control-bodies.test.ts`, `packages/adapters/pi/src/__tests__/child-tree.test.ts`, `packages/adapters/pi/src/__tests__/rpc-child.test.ts`, `packages/adapters/pi/src/__tests__/child-recovery.test.ts`, `packages/adapters/pi/src/__tests__/structured-completion.test.ts`.
  - **Depends on**: Task 3, and Task 4 only if Task 3 proves a gap.
  - **Implementation outline**:
    1. Classify each 4 KiB field and remove truncation from every authoritative path.
    2. Introduce a versioned result reference plus bounded inline projection, completeness flag, total UTF-8 byte count, and retrieval metadata.
    3. Preserve full artifact references via paging; limit only each projected page and enforce an approved total allocation ceiling.
    4. Make restart/recovery rebuild the same reference and projection without treating preview text as authority.
  - **Pitfalls / non-goals**:
    - Never infer a complete result from a preview.
    - Keep control bodies under 64 KiB including JSON/envelope overhead.
    - Do not let stale or forged references cross child identity/session boundaries.
  - **Acceptance**:
    - [user] Results over 4 KiB and over the inline projection cap remain byte-complete and retrievable after settlement and restart.
    - [user] Parent UI/RPC receives a bounded projection with an explicit incomplete marker and stable retrieval reference.
    - [user] More than 32 authoritative artifact references remain available through bounded pages; no artifact is silently dropped.
    - [repo: docs/architecture/adapter-boundary.md#Safe metadata] Cross-boundary references and metadata remain closed, bounded, sanitized shapes.

- [x] 6. Degrade oversized diagnostics safely and consistently
  - **What**: Convert failure reason, protocol reason, and completion display message caps to one approved UTF-8 diagnostic policy that preserves typed codes and truncates only non-authoritative text.
  - **Files**: `packages/adapters/pi/src/child-control-bodies.ts`, `packages/adapters/pi/src/structured-completion.ts`, `packages/adapters/pi/src/errors.ts`, `packages/adapters/pi/src/__tests__/child-control-bodies.test.ts`, `packages/adapters/pi/src/__tests__/structured-completion.test.ts`, `packages/adapters/pi/src/__tests__/child-envelope.test.ts`.
  - **Depends on**: Tasks 1 and 5.
  - **Implementation outline**:
    1. Add one UTF-8-safe bounded projection helper that never splits a code point and reserves room for its truncation marker.
    2. Preserve error kind/code, retriability, and safe structured metadata independently from display prose.
    3. Warn or mark truncation without recursively overflowing the envelope.
  - **Pitfalls / non-goals**:
    - Do not persist arbitrary diagnostic/provider text merely to avoid truncation unless Task 3 proves an approved safe query path.
    - Do not truncate typed codes, identifiers, or authoritative results.
  - **Acceptance**:
    - [user] Multibyte diagnostic text never exceeds the approved byte cap and remains valid UTF-8.
    - [user] Truncated display text carries an explicit marker while the typed failure code remains unchanged.
    - [user] Oversized non-authoritative diagnostics do not cause an otherwise valid child settlement to fail.

- [x] 7. Page target and artifact catalogs instead of rejecting or hiding valid entries
  - **What**: Separate inline page size from total catalog safety; support bounded filtering/paging for targets and artifact references.
  - **Files**: `packages/adapters/pi/src/child-control-bodies.ts`, `packages/adapters/pi/src/delegation-tool.ts`, `packages/adapters/pi/src/structured-completion.ts`, `packages/adapters/pi/src/__tests__/child-control-bodies.test.ts`, `packages/adapters/pi/src/__tests__/delegation-tool.test.ts`, `packages/adapters/pi/src/__tests__/structured-completion.test.ts`.
  - **Depends on**: Tasks 1 and 5.
  - **Implementation outline**:
    1. Add deterministic order, bounded page size, stable continuation, and optional bounded filtering before projection.
    2. Keep a strict approved total materialization/allocation ceiling and a typed error for catalog corruption or impossible continuation.
    3. Make omitted-page state visible; do not represent the first page as the complete eligible set.
  - **Pitfalls / non-goals**:
    - Do not weaken delegation authorization: paging changes discovery, not which targets are allowed.
    - Avoid offset-only paging if concurrent catalog changes can duplicate or skip entries; use a stable snapshot/cursor where needed.
  - **Acceptance**:
    - [user] More than nine eligible targets can be discovered and selected through bounded pages without child failure.
    - [user] Catalog allocation remains bounded by the approved total ceiling.
    - [repo: docs/architecture/adapter-boundary.md#Ownership matrix] Engine authorization remains portable; Pi owns concrete target projection and UI paging.

- [x] 8. Raise and configure portable child, concurrency, depth, and process budgets
  - **What**: Apply approved generous finite ranges in the DSL/schema and engine normalization, then enforce active capacity in Pi with queues and a strict process ceiling.
  - **Files**: `packages/core/src/schema.ts`, `packages/core/src/__tests__/schema.test.ts`, `packages/core/src/__tests__/parser.test.ts`, `packages/core/src/__tests__/validate.test.ts`, `packages/core/src/__tests__/parse_config.test.ts`, `packages/engine/src/delegation-limits.ts`, `packages/engine/src/__tests__/delegation-limits.test.ts`, `packages/adapters/pi/src/delegation-controller.ts`, `packages/adapters/pi/src/__tests__/delegation-controller.test.ts`, `docs/reference/dsl.md`, `docs/adapters/pi.md`.
  - **Depends on**: Tasks 1 and 2.
  - **Implementation outline**:
    1. Update approved schema defaults/maxima and all four required DSL/schema test layers.
    2. Keep child count, active concurrency, depth, and process count distinct; define settled-capacity release.
    3. Queue starts above active/process capacity with bounded queue memory, cancellation, fairness, and shutdown behavior.
    4. Add resource tests at default, hard maximum, one above maximum, and repeated settle/reuse cycles.
  - **Pitfalls / non-goals**:
    - Do not equate total historical children with concurrently running children.
    - Do not spawn above the strict process ceiling even when child/concurrency configuration is larger.
  - **Acceptance**:
    - [user] Approved child/concurrency/depth/process values parse, normalize, and enforce consistently.
    - [user] Excess work waits when capacity can free; settled children release capacity; malformed or above-hard-max configuration fails with a typed validation error.
    - [repo: docs/contributing/testing.md#Schema evolution] Schema, parser, validator, and full-pipeline tests change in the same commit.

- [x] 9. Make child time budgets generous, bounded, renewable, and configurable
  - **What**: Apply approved timeout defaults/maxima, preserve activity-renewed inactivity behavior, and keep cancellation/cleanup fail-closed.
  - **Files**: `packages/adapters/pi/src/child-timer.ts`, `packages/adapters/pi/src/delegation-controller.ts`, `packages/adapters/pi/src/__tests__/child-runtime-budget.test.ts`, `packages/adapters/pi/src/__tests__/delegation-controller.test.ts`, `docs/adapters/pi.md`.
  - **Depends on**: Task 1.
  - **Implementation outline**:
    1. Define validated monotonic-duration settings and hard maxima for handshake, reply, inactivity, and runtime.
    2. Renew only on authenticated/parser-approved progress events; do not let noise or malformed frames extend life.
    3. Test boundary timing with a fake clock, long healthy activity, silence, cancellation, and cleanup.
  - **Pitfalls / non-goals**:
    - Do not remove all time bounds or permit unauthenticated activity to renew them.
    - Avoid wall-clock jumps for elapsed-time enforcement.
  - **Acceptance**:
    - [user] A healthy active child can run for the approved generous duration without hitting the old 10s/15s/15m/60m limits.
    - [user] Silent or over-maximum children still terminate with typed timeout/cancellation results and leave no process or lease.

- [x] 10. Preserve strict transport, parser, paging, and allocation fault containment
  - **What**: Consolidate byte-based boundary helpers and regression tests so the looser product limits do not weaken protocol safety.
  - **Files**: `packages/adapters/pi/src/errors.ts`, `packages/adapters/pi/src/child-envelope.ts`, `packages/adapters/pi/src/child-transfer.ts`, `packages/adapters/pi/src/prompt-chunking.ts`, `packages/adapters/pi/src/child-transcript.ts`, `packages/adapters/pi/src/child-session-checkpoint.ts`, `packages/adapters/pi/src/child-native-sessions.ts`, `packages/adapters/pi/src/__tests__/child-framing.test.ts`, `packages/adapters/pi/src/__tests__/child-envelope.test.ts`, `packages/adapters/pi/src/__tests__/child-transfer.test.ts`, `packages/adapters/pi/src/__tests__/child-session-event-bounds.test.ts`, `packages/adapters/pi/src/__tests__/child-native-session-bounded-reads.test.ts`, `packages/adapters/pi/src/__tests__/child-native-session-paging.test.ts`.
  - **Depends on**: Tasks 2, 5, 6, and 7.
  - **Implementation outline**:
    1. Test exact-minus-one, exact, and plus-one UTF-8 byte boundaries, including multibyte input and encoded envelope overhead.
    2. Preserve 8 MiB frame, 64 KiB control body, 24 KiB chunks, approved aggregate transfer, 32 concurrent transfers, bounded reads, and bounded allocation.
    3. Queue with explicit backpressure where progress is possible; emit typed terminal failures for corruption, impossible continuation, hard ceilings, or shutdown.
  - **Pitfalls / non-goals**:
    - Do not allocate the declared payload size before validating it against the hard ceiling.
    - Do not implement an unbounded queue as a substitute for a transfer/concurrency failure.
  - **Acceptance**:
    - [user] Every retained hard limit has exact byte-boundary and allocation regression coverage.
    - [user] Paging reconstructs complete authoritative data without duplicates, omissions, silent truncation, or unbounded reads.
    - [repo: docs/contributing/typescript.md] All expected limit failures remain typed `neverthrow` values.

- [x] 11. Version protocol and migrate persisted state compatibly
  - **What**: Introduce explicit compatibility handling for changed settlement/reference/catalog wire shapes and any Runtime Store schema change.
  - **Files**: `packages/adapters/pi/src/child-control-bodies.ts`, `packages/adapters/pi/src/child-envelope.ts`, `packages/adapters/pi/src/child-recovery.ts`, `packages/adapters/pi/src/__tests__/child-control-bodies.test.ts`, `packages/adapters/pi/src/__tests__/child-envelope.test.ts`, `packages/adapters/pi/src/__tests__/child-recovery.test.ts`, plus the Task 4 Runtime Store files only if Task 4 was required.
  - **Depends on**: Tasks 4–10 as applicable.
  - **Implementation outline**:
    1. Decide whether the new fields are backward-compatible optional additions or require a protocol-version increment and negotiation/fail-closed mismatch.
    2. Decode supported old settlements as bounded legacy projections without claiming unavailable full output; new peers use references/full retrieval.
    3. Test mixed old/new peer messages, unknown versions, interrupted transfers, restart recovery, stale references, and database migration rollback/failure.
  - **Pitfalls / non-goals**:
    - Never invent missing authoritative bytes for a legacy record that stored only 4 KiB.
    - Do not silently accept a new wire shape under an old authenticated canonical form if that changes signed/canonical bytes.
  - **Acceptance**:
    - [user] Supported old state/messages recover without data fabrication; unsupported versions fail with a typed compatibility error.
    - [user] New authoritative results are never truncated during settlement, recovery, migration, or mixed-version handling.
    - [repo: docs/contributing/testing.md] Protocol/schema changes land with focused compatibility and migration tests.

- [x] 12. Add bounded CLI retrieval and update user/operator documentation
  - **What**: Reuse or extend Runtime Store CLI queries so users can inspect full retained child output/history by stable ID with bounded pages and explicit truncation/continuation state.
  - **Files**: `packages/cli/src/commands/runtime.ts`, `packages/cli/src/commands/__tests__/runtime.test.ts`, `docs/reference/runtime.md`, `docs/adapters/pi.md`, `docs/reference/dsl.md`.
  - **Depends on**: Task 3; Tasks 4–5 if a new reference/query is required; Task 8 for DSL values.
  - **Implementation outline**:
    1. Reuse current commands if they meet the requirement; otherwise add the narrowest bounded query through existing engine command operations.
    2. Require page/byte bounds, stable ordering/continuation, safe identifiers, and explicit completeness metadata.
    3. Document defaults, maxima, byte units, queue behavior, projection semantics, retained hard limits, privacy/retention, migration, and recovery.
  - **Pitfalls / non-goals**:
    - Do not print unbounded output by default or expose database paths/raw SQL as the API.
    - Do not add a CLI command merely to duplicate an existing bounded query.
  - **Acceptance**:
    - [user] A user can retrieve complete retained authoritative result/history through bounded CLI pages and can distinguish a projection from complete data.
    - [user] Durable data uses the Runtime Store database, not standalone files.
    - [repo: docs/architecture/adapter-boundary.md#Runtime state] CLI access goes through bounded engine APIs and does not expose Pi-private paths or raw events.

- [ ] 13. Run focused, workspace, migration, performance, and real Pi proof
  - **What**: Verify limits, compatibility, resource containment, exact artifact identity, and real child behavior.
  - **Depends on**: Tasks 2–12.
  - **Implementation outline**:
    1. Run focused unit/contract tests for every touched module, including large multibyte tasks/results, paging, queue saturation, timeout renewal, cancellation, migrations, and restart recovery.
    2. Run workspace tests, typecheck, lint, build, and docs-link checks.
    3. Measure memory/process behavior at approved defaults and hard maxima; confirm queues and pages remain bounded.
    4. Follow the Pi exact-artifact fresh-process procedure and run real long-task, large-result, many-target, queued-concurrency, direct-step settlement, restart/retrieval, and cleanup cases.
  - **Pitfalls / non-goals**:
    - Do not use mocks, package imports, logs, or visible prose as the sole adapter proof.
    - Do not claim hard-maximum viability without observed process/memory evidence.
  - **Acceptance**:
    - [repo: docs/testing/adapter-verification.md#Required proof] The built and installed entry-point digests match; a fresh interactive Pi reports ready; real delegation and direct-step work settle; no child process or execution lease remains.
    - [user] Real Pi proves an authoritative task above 8,192 characters and result above the approved inline projection remain complete and retrievable.
    - [user] Real Pi proves excess concurrent work waits and resumes, while strict transport/process/allocation ceilings still fail closed with typed errors.
    - [repo: package.json#scripts] Workspace test, typecheck, lint, build, and docs-link commands pass.
  - **Completion record**:
    - Evidence obtained: focused test groups pass; workspace `bun test` reports 8,389 pass, 0 fail, 11 skip; `bun run typecheck`, `bun run lint`, `bun run build`, `bun run docs:check-links`, and the cached diff check pass; Warp verdict APPROVE; full-suite peak RSS about 2.05 GB.
    - Review remediation (Weft): removed a durable cumulative 64-run failure in `child-session-refs.ts` by separating the retained run window from the cumulative `totalRuns` count, with matching fixes in `child-metadata-cache.ts`, `child-overlay-types.ts`, `child-overlay-replay.ts`, and `delegation-controller.ts`, and regression coverage at run 65, past run 1,000, and across a restart; applied the shared 32 KiB UTF-8 diagnostic projection to the protocol `cancel`/`error` reasons through the new `child-diagnostic-projection.ts`, with multibyte and exact-byte-boundary coverage; removed the unrelated, incomplete `prompt eject` diff from `packages/cli`, `docs/reference/cli.md`, and `docs/reference/configuration.md` while keeping the `children result` route.
    - Explicitly waived by the user: the real Pi cases (long task, large result, many targets, queued concurrency, direct-step settlement, restart/retrieval, cleanup) and the exact-artifact fresh-process proof. These were not run, so no live Pi evidence and no exact-artifact digest match are claimed.
    - Not established: hard-maximum viability was not observed, because it depends on the waived live Pi and process/memory measurement at hard maxima.

## Verification

Status note: every command listed below passed, except the final fresh exact-artifact Pi TUI verification, which the user explicitly waived. It was not run.

- `bun test packages/adapters/pi/src/__tests__/delegation-controller.test.ts packages/adapters/pi/src/__tests__/delegation-tool.test.ts packages/adapters/pi/src/__tests__/child-transfer.test.ts packages/adapters/pi/src/__tests__/child-control-bodies.test.ts packages/adapters/pi/src/__tests__/structured-completion.test.ts packages/adapters/pi/src/__tests__/child-recovery.test.ts` — source: `[repo: package.json#scripts.test]`; proves: focused Pi task, transport, settlement, projection, and recovery behavior.
- `bun test packages/adapters/pi/src/__tests__/child-framing.test.ts packages/adapters/pi/src/__tests__/child-envelope.test.ts packages/adapters/pi/src/__tests__/child-session-event-bounds.test.ts packages/adapters/pi/src/__tests__/child-native-session-bounded-reads.test.ts packages/adapters/pi/src/__tests__/child-native-session-paging.test.ts` — source: `[repo: docs/contributing/testing.md]`; proves: strict framing, parser, bounded read, and paging regression coverage.
- `bun test packages/core/src/__tests__/schema.test.ts packages/core/src/__tests__/parser.test.ts packages/core/src/__tests__/validate.test.ts packages/core/src/__tests__/parse_config.test.ts packages/engine/src/__tests__/delegation-limits.test.ts` — source: `[repo: docs/contributing/testing.md#Schema evolution]`; proves: portable limit schema/parser/validator/pipeline and engine normalization agree.
- `bun test packages/engine/src/__tests__/runtime-contract.test.ts packages/engine/src/__tests__/runtime-memory.test.ts packages/engine/src/__tests__/runtime-sqlite.test.ts packages/cli/src/commands/__tests__/runtime.test.ts` — source: `[repo: docs/contributing/testing.md#Module isolation]`; proves: durable result/query contracts, migrations, paging, and CLI bounds if Task 4/12 changes them.
- `bun test` — source: `[repo: package.json#scripts.test]`; proves: all workspace tests pass.
- `bun run typecheck` — source: `[repo: package.json#scripts.typecheck]`; proves: package and script type contracts pass.
- `bun run lint` — source: `[repo: package.json#scripts.lint]`; proves: Biome and declaration validation pass.
- `bun run build` — source: `[repo: package.json#scripts.build]`; proves: public packages and docs build.
- `bun run docs:check-links` — source: `[repo: package.json#scripts.docs:check-links]`; proves: documentation links remain valid.
- Fresh exact-artifact Pi TUI verification with `/weave:health`, `/weave:status`, ordinary delegation, direct workflow-step completion, bounded full-result retrieval, and post-run lease/process checks — source: `[repo: docs/testing/adapter-verification.md#Pi]`; proves: packaged load, readiness, real large-data behavior, settlement, recovery, and cleanup.
