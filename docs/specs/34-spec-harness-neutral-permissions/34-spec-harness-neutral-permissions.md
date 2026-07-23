# Spec 34 — Harness-neutral Permission Subsystem

**Status:** Accepted

**Related:** [Permissions guide](../../permissions.md) · [ADR 0009](../../adr/0009-input-aware-tool-permission-authorization.md) · [Tool Policy Evaluation](../../tool-policy-evaluation.md) · [Spec 13 — Minimal Execution Lifecycle Surface](../13-spec-minimal-execution-lifecycle-surface/13-spec-minimal-execution-lifecycle-surface.md) · [Spec 12 — Runtime Persistence](../12-spec-runtime-persistence/12-spec-runtime-persistence.md) · [Adapter Boundary](../../adapter-boundary.md) · [Spec 33 — Pi adapter](../33-spec-pi-adapter/33-spec-pi-adapter.md)

## 1. Purpose

This specification defines input-aware authorization for concrete harness tool calls. It applies to ordinary interactive agents, delegated agents, and workflow steps. It supersedes the workflow-only `beforeTool` evaluator as the general execution-authorization contract.

The subsystem MUST use `Result<T, E>` and `ResultAsync<T, E>` for expected failures. Its public closed unions MUST be exhaustively testable.

## 2. Ownership boundary

### 2.1 Engine ownership

The engine owns:

- registry validation and immutable registry generations;
- request validation, canonicalization, and authorization-key computation;
- effective-policy binding and evaluation;
- approval challenges and scopes;
- session and durable grant state;
- grant matching, expiry, revocation, and invalidation;
- short-lived single-use execution permits;
- bounded audit records and typed failures.

### 2.2 Adapter ownership

Adapters own:

- concrete tool discovery and runtime identities;
- trusted registration inputs and input resolvers;
- interception of registered calls;
- native approval UI and unavailable-UI behavior;
- parent/child transport for approval prompts;
- permit consumption immediately before final enforcement and execution;
- capability probes and health rendering.

An adapter claiming tool-policy readiness MUST register every native or Weave-owned tool that can exercise an abstract capability and MUST prove that each call passes through interception. Missing or bypassable coverage fails that adapter's required capability probe. Only unrelated third-party tools may remain unregistered and `unmanaged`. The engine MUST NOT label them `allow` or issue a permit. Existing third-party tool owners retain their behavior until they register with a trusted controller.

Coverage proof is engine-owned and harness-neutral. Adapters discover concrete inventories and interception claims, then call `verifyPermissionCoverage(context)` with an explicit immutable context. The engine MUST NOT discover harness tools or know concrete harness names beyond the opaque string identities supplied in that context. Concrete adapter wiring that maps coverage failure onto required `tool-policy-mapping` readiness is a later adapter task (issue #21 "Enforce registered-tool policy"); this specification defines the neutral proof primitive and fake-adapter proof obligations.

## 3. Public roles

The engine MUST expose these public roles:

1. `PermissionRegistryBuilder`, which accepts trusted registrations and returns `Result` from registration and sealing;
2. `PermissionRegistryGeneration`, an immutable sealed snapshot;
3. `PermissionService`, created with `createPermissionService(store)`;
4. `PermissionSession`, an opaque branded handle returned by the service;
5. `verifyPermissionCoverage(context)`, a pure coverage-proof helper returning `Result<PermissionCoverageProof, PermissionCoverageError>`.

`PermissionService.activate` binds the project, controller session ID, immutable registry generation, stable agent-to-effective-policy map, and request schema version. The service obtains the durable-grant repository from an engine-internal association on the `RuntimeStore`. The repository, clock, ID source, grant records, identity envelopes, and per-call policy are never activation inputs supplied by an adapter. Production activation uses engine-owned clock and opaque-ID sources. Direct dependency injection is limited to a non-root internal testing factory.

The API MUST support:

- registering and sealing a candidate registry;
- activating and closing a permission session;
- atomically replacing a registry while idle;
- authorizing an intercepted call;
- answering or cancelling an approval challenge;
- consuming a permit immediately before execution;
- listing and revoking sanitized durable-grant summaries through engine APIs.

Adapters MUST NOT receive grant records, identity envelopes, repository objects, clocks, ID sources, or policy-matching internals. Runtime Store instances expose only workflow, lease, snapshot, and journal repositories. Memory and SQLite stores keep their permission repository in a private engine-owned field associated through a module-private `WeakMap`.

Session and registry-generation values are unforgeably branded with module-private `WeakSet`s. Prototype copies, proxies, copied methods, and prototype mutation fail closed with typed validation errors; they are never accepted as live authorization state.

`PermissionSession` is constructed only through a module-private activation closure. After each successful construction the genuine instance is frozen so own-method shadowing of `authorizeCall`, `consumePermit`, `answerChallenge`, `cancelChallenge`, `replaceRegistry`, `close`, `listDurableGrants`, `revokeDurableGrant`, and `listAudit` cannot stick (ECMAScript `#private` state remains mutable internally). After class definition the exported constructor and prototype are frozen so static mutation and prototype method replacement cannot redirect construction or public method dispatch. Activation remains available only through the module-private closure bound before freeze. Authoritative engine paths such as workflow `beforeTool` MUST authorize through a module-private non-virtual accessor that calls the captured original `authorizeCall` (never dynamic own/prototype lookup). Permit consumption may use the public method on a frozen genuine instance because the original prototype method is immutable, or an equivalent non-virtual helper; either path MUST keep single-use semantics and MUST NOT execute a forged permit.

`PermissionRegistryGeneration` is constructed only through a module-private closure/factory. There is no public `fromToken` (or other public construction-token) surface: the construction token never appears on a class, static, or public property, so JS monkey patches cannot capture the token or supply attacker-chosen source/identity/id. After definition, the exported class constructor and prototype are frozen. Public `lookup` / `get` / `inventory` are informational only. Authoritative engine paths — session authorization, permit revalidation, registry replacement binding, and `verifyPermissionCoverage` — MUST use module-private non-virtual accessors backed by `#private` / `WeakMap` state. Genuine instance own-method shadowing and prototype `lookup`/`get`/`inventory` mutation MUST NOT redirect those decisions. Deterministic generation-id sources for collision tests remain a non-root, module-internal WeakMap seam on the builder and MUST NOT monkey-patch the production class.

The package root exports only the normalized registration/request/session contracts, outcomes, challenge and permit views, sanitized administration views, coverage proof contracts, and service facade. Repository records, grant envelopes, clocks, ID sources, hydration helpers, internal registry accessors, and construction/testing hooks are internal.

### 3.1 Permission coverage proof

`verifyPermissionCoverage` accepts an exact plain object context with:

- the actual branded sealed `PermissionRegistryGeneration`;
- `nativeToolIdentities` and `weaveOwnedToolIdentities` inventories that MUST be registered and non-bypassably intercepted;
- `interceptedToolIdentities` claimed by the adapter;
- `bypassableToolIdentities` claimed by the adapter;
- `unmanagedThirdPartyToolIdentities` that may remain unregistered and receive no permit;
- a `diagnostics` policy object with boolean `includeToolIdentities`.

Validation rules:

- snapshot the context once from own enumerable data properties only — no getters, proxies, hidden keys, sparse arrays, or extras;
- inventory arrays (`nativeToolIdentities`, `weaveOwnedToolIdentities`, `interceptedToolIdentities`, `bypassableToolIdentities`, `unmanagedThirdPartyToolIdentities`) MUST use the shared one-shot descriptor-based array snapshot: capture prototype, `Reflect.ownKeys`, the own data `length` descriptor/value, and every indexed data descriptor exactly once inside `Result.fromThrowable`, then validate only that frozen capture. Live length and indices MUST NOT be reread. Accessors, symbol keys, sparse holes, non-index extras, out-of-range keys, non-safe lengths, non-`Array.prototype` prototypes, and reflection traps fail as `invalid_coverage`. A disappearing required native/Weave/registered/intercepted/bypassable/unmanaged identity MUST fail `invalid_coverage` and MUST NOT yield zero-count readiness success;
- every identity is a plain bounded nonempty string (at most 256 UTF-8 bytes) with no lone surrogates;
- reject duplicate identities within a list and overlap ambiguity across native, weave-owned, unmanaged, and registered sets;
- fail `incomplete_coverage` when any required native/Weave tool lacks registration, any registered tool (including registered third-party tools) lacks interception, any required or registered tool is marked bypassable, or the registry generation/inventory changes after the initial snapshot;
- return a dedicated closed error union of `invalid_coverage` (malformed context) and `incomplete_coverage` (semantic gap) with safe bounded fields only;
- on success return an immutable `PermissionCoverageProof` containing generation id, metadata identity, and safe counts; deterministic tool-identity lists appear only when `diagnostics.includeToolIdentities` is true.

The proof MUST NOT expose resolvers, policies, grants, digests, raw calls, or repository internals. Adapters map either error variant to required tool-policy readiness failure for the controller generation.

## 4. Registrations and registry lifecycle

A trusted registration contains:

- an opaque concrete runtime tool identity of at most 256 UTF-8 bytes;
- stable owner or integration identity of at most 128 UTF-8 bytes;
- a semantic registration revision of at most 64 UTF-8 bytes;
- presentation summary of at most 256 UTF-8 bytes and details of at most 2 KiB;
- a pure synchronous deterministic resolver returning `Result`.

The resolver receives validated immutable call input and registration context. It MUST NOT perform I/O, discovery, mutation, network access, or the proposed tool operation. The adapter MUST perform discovery before registration and provide context explicitly.

One concrete tool identity has one authoritative resolver. A duplicate rejects the complete candidate generation, even when both registrations appear identical. There is no first-wins, load-order, or composition rule.

Sealing makes the registry immutable. The metadata-only `identity` is a SHA-256 digest of the sorted registration metadata and is independent of registration order and resolver function identity. Each successful seal also receives a fresh opaque generation `id` that is controller-process-unique and distinct from metadata identity: the id is not derived from metadata and cannot be supplied by a production caller. The builder seals through the module-private generation factory only; callers cannot construct a generation with a chosen identity, id, or registration source via any public static or constructor entry point. The engine mints ids through a secure source (`crypto.randomUUID` in production), wraps source failures as typed `invalid_registry`, and check-and-reserves each candidate in a single synchronous critical section so concurrent seals in one JS process cannot race into duplicate ids. On collision the engine retries a bounded number of times; after exhaustion it returns `invalid_registry` without producing a generation. Issued ids are retained for the life of the controller process and are never reused while any session that observed a prior generation may still exist. The retained set is bounded only operationally by the number of successful seals (rare controller events); sliding eviction is rejected because an evicted id could be reissued against a still-live session. Deterministic id sources for collision tests are limited to a non-root internal testing factory backed by a module-private WeakMap; production callers cannot inject generation ids, observe the issued-id set, or patch the production class to install a source.

A trusted controller may replace a live registry only through an atomic operation that checks the session's live state after purging expired challenges and permits; callers cannot assert that the session is idle. Each session tracks the set of registry generation IDs it has observed, initialized with the activation generation and extended on each successful replacement (ID recorded before swap). Replacement of the current ID or any retired/previously observed ID MUST fail closed as `invalid_registry_transition` (covering A→A and A→B→A replay). A fresh unseen generation may replace only while the session is internally idle; active challenges or unconsumed live permits still yield `non_idle_replacement`. Successful replacement binds the new generation and invalidates outstanding challenges and permits. Durable grants continue to match only when their full identity envelope remains unchanged. Registry metadata identity, generation id, and registration lookup used during replacement binding and subsequent authorization MUST be read through the module-private non-virtual accessors, not through attacker-replaceable public instance methods or virtual `.id` reads.

Registration and replacement are trusted controller APIs and MUST NOT be model-callable tools.

## 5. Normalized requests

A grantable request contains:

- `capability`: `read`, `write`, `execute`, `delegate`, or `network`;
- `operation`: a stable normalized action identifier of at most 128 UTF-8 bytes;
- `target`: a canonical kind of at most 64 UTF-8 bytes and identifier of at most 2 KiB;
- `constraints`: optional RFC 8785 canonical JSON of at most 16 KiB containing all further authorization-narrowing facts;
- `display`: sanitized summary of at most 256 UTF-8 bytes and optional details of at most 2 KiB.

Authorization fields and presentation fields are separate. The engine validates and canonicalizes authorization fields and computes their key. A resolver MUST NOT supply an opaque approval key. Display fields do not affect authorization and MUST NOT contradict authorization fields.

Different security effects MUST produce different authorization fields. A semantic resolver change MUST increment the registration revision. Resolver output MUST contain at least one request. Exact duplicate requests are evaluated once.

`normalizePermissionRequests` MUST snapshot resolver output with the shared one-shot descriptor-based array primitive before any emptiness or element validation: capture prototype, `Reflect.ownKeys`, the own data `length` descriptor/value, and every indexed data descriptor exactly once inside `Result.fromThrowable`. It MUST enforce captured length ≥ 1 against that freeze and MUST normalize only the captured elements. Live length and indices MUST NOT be reread. A changing length/key/value proxy MUST NOT turn deny requests into empty or allowed output on authorize or on permit-consume re-resolution. Accessors, symbol keys, sparse holes, non-index extras, out-of-range keys, non-safe lengths, and reflection traps map to closed `invalid_output` (or `empty_output` when the captured snapshot is genuinely empty). Serialized errors MUST NOT include raw resolver values or keys.

Canonical values may be held in memory to compute a digest. Durable state stores only the digest, identity envelope, sanitized display, scope, and timestamps. It MUST NOT store raw harness input, secrets, or unsanitized constraints.

All structural, canonicalization, and display validators MUST return closed `Result` errors when they inspect hostile values. They MUST NOT invoke accessors. Reflection traps are mapped to the layer's safe error (`unsafe_input` for intercepted call cloning, `invalid_output` for resolver output, and `invalid_registration` for registration/context validation). Diagnostic paths use only fixed labels and opaque object components; attacker-controlled object keys and values MUST NOT appear in serialized errors. Array indices MAY remain numeric.

Permission display text is validated by one shared `sanitizePermissionDisplay` contract used for requests, registrations, durable records, and hydrated rows. Summary is at most 256 UTF-8 bytes; details is optional and at most 2048 UTF-8 bytes. Empty details normalize to omission. Lone surrogates, C0/C1 controls (including newline, tab, and ESC), ANSI controls, bidi direction overrides and isolates, Unicode line and paragraph separators, default-ignorable characters, and other invisible formatting are rejected. Display errors MUST NOT include the rejected text.

### 5.1 Unresolved requests

A resolver may return an explicit non-grantable `unresolved` request when known supported input cannot be mapped safely. This is not a resolver error.

An unresolved request:

- requires approval for every call;
- accepts only allow-once or reject;
- cannot create session or durable grants;
- blocks when approval UI or an answer is unavailable;
- degrades adapter health;
- binds its one-time challenge and permit to an immutable input snapshot or transient digest.

A throw, returned error, unsafe input, invalid output, or empty output is a typed resolver failure. It blocks without a challenge or grant and remains distinct from policy denial.

## 6. Evaluation

A session binds each active agent to its engine-computed effective policy. The adapter identifies the active agent but MUST NOT inject a per-call policy.

For each registered call, the engine MUST:

1. resolve and validate all requests;
2. deduplicate exact requests;
3. evaluate every request against bound policy;
4. apply `deny` regardless of grants;
5. satisfy `allow` without a grant;
6. match a valid grant for `ask` or request approval;
7. authorize only when every request is satisfied.

One denied request blocks the full call. Each pending request retains its own identity, decision, source, and reason even when the UI groups them. Pending request views are frozen closed records with these per-request evaluation fields in addition to request identity and sanitized display (and grantable authorization fields when applicable):

- `decision`: always `ask`. Policy `deny` is a separate outcome; policy `allow` never becomes pending.
- `source`: `policy` when a grantable request is pending under effective capability policy `ask` without a matching grant; `resolver` when the request is an explicit unresolved mapping.
- `reason`: closed bounded enum — `policy_ask_without_grant` (grantable ask, no grant) or `unresolved_request` (resolver could not map input safely).

Denied outcome views are presentation-only and do not carry pending evaluation fields or challenge `requestId` values.

Authorization returns exactly one outcome:

- `unmanaged`: no registration; no enforcement claim or permit;
- `denied`: policy blocked one or more requests;
- `approval_required`: opaque challenge plus pending request views;
- `authorized`: opaque execution permit.

Registration, resolver, validation, repository, stale-state, and lifecycle failures are errors outside this outcome union.

## 7. Approval scopes and grants

Native UI may offer each grantable pending request:

- allow once;
- allow for this permission session;
- allow durably for this project, with optional expiry;
- reject this call.

Durable grants have no mandatory default expiry. Without one, a grant remains until revocation or invalidation. Approval memory stores grants only. Rejecting a prompt MUST NOT create hidden deny policy; lasting denial belongs in `.weave` configuration.

Session and durable grants match only within:

- project identity;
- stable agent name;
- registration owner and concrete tool identity;
- semantic registration revision;
- effective-policy fingerprint;
- request schema/canonicalization version;
- exact normalized request digest.

A child agent never inherits a parent grant. Private children may relay prompts to the parent UI, but evaluation remains under the child's identity and policy. Session grants disappear on controller close. Durable grants are project-scoped Runtime Store records and become ineligible after envelope changes, expiry, or revocation.

## 8. Challenges and execution permits

An unanswered challenge expires after five minutes. A permit expires after 30 seconds, is opaque and single-use, and is bound to:

- project and session identity;
- stable agent identity;
- registry generation;
- effective-policy fingerprint;
- normalized request keys or transient unresolved binding;
- the exact intercepted call;
- expiry and consumption state.

A session may hold at most 128 outstanding challenges and 128 unconsumed permits; exceeding either bound blocks new authorization with a typed capacity error. The adapter MUST consume the permit immediately before execution. Successful `consumePermit` / non-virtual `consumePermissionSessionPermit` returns `ResultAsync<PermissionExecutionSnapshot, PermissionError>` where `PermissionExecutionSnapshot` is a deep-frozen engine-owned JSON clone of the exact call captured and validated during consume. Adapters MUST execute **only** that returned snapshot — never the caller-owned consume input, a live proxy, or any object reference that escaped from the caller. Authorization MUST NOT be treated as executable without a successful snapshot return. Caller mutation after consume, data-descriptor vs get-proxy disagreement, nested mutation, input swap, and permit replay MUST NOT change the executed snapshot or revive a consumed permit. Changed input, wrong agent/session, stale generation, changed policy, expiry, unknown identity, or repeated use MUST block with a typed error. Registry generation is intentionally absent from the reusable grant envelope: a replacement preserves session and durable grants only when project, agent, owner, tool, revision, policy, schema, and request digest all remain unchanged. Successful replacement records only a bounded, non-sensitive audit event.

Challenge (5 minute) and permit (30 second) deadlines use an engine-owned **monotonic** clock. Audit timestamps and durable grant `createdAt` / expiry comparisons use a **wall** clock. Production `PermissionService` injects a steady `performance.now`-based monotonic source and `Date.now` wall source; test activation accepts independent fake clocks. Both session clocks maintain nondecreasing high-water marks: a regressing source reuses the prior high-water (or fails closed) and MUST NOT extend volatile TTL. Durable repositories maintain an engine-internal wall-clock high-water (in-memory field; SQLite `runtime_metadata` key `permission_wall_clock_high_water`) observed on every successful save/match/list and on every revoke of a **known in-project grant** (including already-revoked idempotent revokes) as `max(previousHighWater, suppliedNow)`. Revoke ordering is: validate → resolve grant → unknown/wrong-project returns `unknown_grant` **without** observing high-water (no attacker poisoning via random IDs) → observe/update high-water → then idempotent already-revoked return or mutate. Match compares grant expiry to that effective high-water. Once a durable grant is observed expired it MUST remain ineligible after wall rollback and after SQLite close/reopen under a lower clock. SQLite open/migration MUST reject hostile `runtime_metadata` / `schema_migrations` triggers and unexpected indexes via exact bootstrap `sqlite_schema` inventory **before** trusting metadata contents, so triggers that reset high-water or rewrite the ledger cannot run under a healthy store handle (see [Spec 12](../12-spec-runtime-persistence/12-spec-runtime-persistence.md)). High-water is never part of the public adapter surface. Concurrent repository operations serialize/transactionally update high-water without lost maxima (SQLite: `BEGIN IMMEDIATE` + shared bounded `SQLITE_BUSY` retry across store instances; max-preserving metadata UPSERT). Clock exceptions map to `repository_failure` (repository) or typed session invalid output and MUST NOT reject the returned `ResultAsync`.

Permission audit output is a closed union of bounded, frozen records. It records policy denial, approval requested/answered (with `approved` or `rejected` outcomes), permit issuance/consumption, permit errors such as expiry, grant revocation, registry replacement, and session close. A valid user rejection is an `approval_answered` event with outcome `rejected`; it is not an `invalid_response` error. Audit records may contain only bounded project, agent, tool, count, timestamp, fixed outcome, and error-category scalars. Recursive data-ban checks exclude raw call keys and values, constraints, display secrets, request/challenge/permit identifiers, digests, and repository causes.

Answering a challenge records reusable grants atomically and yields a permit only after every request passes. Partial approval never executes a multi-request call. Cancellation or unavailable UI creates no permit. Challenges and permits are not durable across controller sessions.

Mutations and grant writes MUST be serialized or transactionally guarded so concurrent calls cannot reuse once approval or race registry replacement. The shared in-memory repository rejects `saveMany([])` with typed `invalid_output`, matching the SQLite contract. Non-empty batches validate every record before mutating state; a failed batch leaves the queue and stored records usable. The SQLite implementation uses the migration-v3 allowlist, strict row hydration, fail-closed `repository_failure` handling for corrupt rows, candidate-only conflict preflight, `BEGIN IMMEDIATE` writer serialization with shared bounded busy retry (save + high-water; multi-store concurrent high-water observations must deterministically persist the global max under normal contention), and typed mapping of primary-key/unique conflicts to `invalid_output` so concurrent multi-store duplicate grants match memory/sequential behavior; see [Spec 12](../12-spec-runtime-persistence/12-spec-runtime-persistence.md). Injected store clocks drive revoke timestamps and wall high-water observation for both backends; throwing clocks fail closed as `repository_failure` without rejecting the returned `ResultAsync` or poisoning later operations.

## 9. Failure contract

The permission error union MUST distinguish at least:

- invalid registration;
- duplicate registration;
- invalid registry transition;
- non-idle registry replacement;
- resolver returned error;
- resolver threw;
- unsafe, invalid, or empty normalized output;
- approval repository failure;
- stale, unknown, expired, or consumed challenge;
- stale, unknown, expired, or consumed permit;
- invalid approval scope or response;
- closed or mismatched session;
- unavailable approval UI for unresolved input;
- challenge or permit capacity exceeded.

Adapters MUST block on each permission error. Diagnostics may include registration identity, agent, error category, and registry generation. They MUST NOT include raw call input, authorization constraints, secrets, or approval digests.

## 10. Lifecycle compatibility

The general permission session is independent of workflow execution. The workflow `beforeTool` projection MUST call this subsystem or a compatibility wrapper over it. It MUST NOT maintain separate grant or permit semantics. `beforeTool` is only the registered/intercepted-call compatibility path: it accepts `RegisteredBeforeToolInput`, not static policy fields, and cannot dispatch based on attacker-controlled input shape. Its top-level and nested permission context must be exact plain own enumerable records; accessors, proxies, omitted fields, and extras produce a lifecycle validation error before authorization. Authorization MUST go through the module-private non-virtual session authorize entry (captured original / non-virtual accessor), never through dynamic own or prototype `authorizeCall` lookup on an attacker-controlled surface. Throws and rejections from that path MUST be wrapped as typed errors. Static one-capability policy evaluation belongs to the non-authoritative `previewToolPolicy` helper, which cannot authorize execution or establish adapter readiness.

Adapters may hide a tool that is proven always denied, but every registered tool call that can still be invoked MUST pass through interception and permit enforcement.

## 11. Verification

Isolated automated tests MUST cover:

- duplicate rejection and atomic registry generations;
- absence of a public `fromToken` / construction-token surface, frozen generation constructor and prototype, and failure of patched-static token capture;
- genuine instance own-method shadowing and prototype `lookup`/`get`/`inventory` mutation that cannot affect internal non-virtual accessors or coverage/authorization decisions;
- frozen `PermissionSession` instances, constructor, and prototype; failed own-method `defineProperty`/assignment on `authorizeCall`/`consumePermit` and related methods; failed prototype and static mutation; deny remains denied; forged permits never execute; genuine permits remain single-use and return a frozen execution snapshot;
- post-consumption snapshot execution only: caller mutation after success, descriptor/get proxy disagreement, nested mutation, swap, and replay cannot change the executed snapshot;
- monotonic/wall clock split with high-water clamping: challenge/permit TTL and durable expiry cannot extend or resurrect after source rollback; idempotent revoke observes high-water before early return; unknown/wrong-project revoke does not poison high-water; multi-store concurrent high-water observations persist the global max; SQLite reopen under a lower wall clock keeps observed-expired grants ineligible; hostile `runtime_metadata`/`schema_migrations` triggers fail open before high-water can reset or resurrect; no-expiry durable grants and session grants remain valid;
- `beforeTool` non-virtual authorize path immune to genuine-session method shadowing;
- brand rejection of prototype copies, proxies, and method-copied objects for registry generations;
- registry generation replay rejection (A→A and A→B→A as `invalid_registry_transition`) with active-state `non_idle_replacement` preserved for fresh unseen IDs;
- resolver success, unresolved output, returned error, throw, empty output, and invalid output;
- multi-request deduplication and deny/ask/allow precedence;
- once, session, durable, expiring, revoked, and invalidated grants;
- project, agent, policy, registration revision, and generation isolation;
- challenge and permit replay, staleness, expiry, input swapping, and concurrent consumption;
- unresolved approval with and without UI;
- child approval relay without parent grant inheritance;
- registry replacement invalidation and observed-generation tracking;
- Runtime Store failures and data-ban compliance;
- workflow `beforeTool` compatibility for registered calls (with `unmanaged` never treated as `allow`);
- complete native/Weave-owned inventory coverage and failure on a missing or bypassable registration via `verifyPermissionCoverage`;
- missing interception for registered third-party tools;
- invalid plain-context rejection (getters, proxies, extras, duplicates, overlap ambiguity);
- unmanaged third-party tools receiving no Weave permit;
- fake-adapter proof that every managed call authorizes through `PermissionService`/`PermissionSession`, consumes its permit immediately before one recorded execution, and blocks input swap/replay without a live harness.

Tests MUST use in-memory repositories, pure resolvers, and fake adapter ports. They MUST NOT start a real harness, child process, network request, or approval UI.

## 12. Non-goals

This contract does not standardize concrete tool names, harness discovery, approval widgets, RPC framing, or adapter process control. It does not grant Weave authority over unregistered third-party tools.
