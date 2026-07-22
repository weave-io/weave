# Spec 34 — Harness-neutral Permission Subsystem

**Status:** Accepted

**Related:** [ADR 0009](../../adr/0009-input-aware-tool-permission-authorization.md) · [Tool Policy Evaluation](../../tool-policy-evaluation.md) · [Spec 13 — Minimal Execution Lifecycle Surface](../13-spec-minimal-execution-lifecycle-surface/13-spec-minimal-execution-lifecycle-surface.md) · [Adapter Boundary](../../adapter-boundary.md) · [Spec 33 — Pi adapter](../33-spec-pi-adapter/33-spec-pi-adapter.md)

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

## 3. Public roles

The engine MUST expose class-backed roles equivalent to:

1. `PermissionRegistryBuilder`, which accepts trusted registrations and returns `Result` from registration and sealing;
2. `PermissionRegistryGeneration`, an immutable sealed snapshot;
3. `PermissionSession`, which binds one project, trusted controller session, registry generation, and stable agent-to-effective-policy map;
4. `PermissionApprovalRepository`, an engine Runtime Store surface for durable grants whose storage implementation does not interpret policy.

The API MUST support:

- registering and sealing a candidate registry;
- activating and closing a permission session;
- atomically replacing a registry while idle;
- authorizing an intercepted call;
- answering or cancelling an approval challenge;
- consuming a permit immediately before execution;
- listing and revoking durable grants through engine APIs.

Adapters MUST NOT receive grant records or policy-matching internals.

## 4. Registrations and registry lifecycle

A trusted registration contains:

- an opaque concrete runtime tool identity of at most 256 UTF-8 bytes;
- stable owner or integration identity of at most 128 UTF-8 bytes;
- a semantic registration revision of at most 64 UTF-8 bytes;
- presentation summary of at most 256 UTF-8 bytes and details of at most 2 KiB;
- a pure synchronous deterministic resolver returning `Result`.

The resolver receives validated immutable call input and registration context. It MUST NOT perform I/O, discovery, mutation, network access, or the proposed tool operation. The adapter MUST perform discovery before registration and provide context explicitly.

One concrete tool identity has one authoritative resolver. A duplicate rejects the complete candidate generation, even when both registrations appear identical. There is no first-wins, load-order, or composition rule.

Sealing makes the registry immutable. A trusted controller may replace it only through an atomic idle-time operation. Replacement creates a new generation and invalidates outstanding challenges and permits. Durable grants continue to match only when their full identity envelope remains unchanged.

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

Canonical values may be held in memory to compute a digest. Durable state stores only the digest, identity envelope, sanitized display, scope, and timestamps. It MUST NOT store raw harness input, secrets, or unsanitized constraints.

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

One denied request blocks the full call. Each pending request retains its own identity, decision, source, and reason even when the UI groups them.

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

A session may hold at most 128 outstanding challenges and 128 unconsumed permits; exceeding either bound blocks new authorization with a typed capacity error. The adapter MUST consume the permit immediately before execution. Changed input, wrong agent/session, stale generation, changed policy, expiry, unknown identity, or repeated use MUST block with a typed error.

Answering a challenge records reusable grants atomically and yields a permit only after every request passes. Partial approval never executes a multi-request call. Cancellation or unavailable UI creates no permit. Challenges and permits are not durable across controller sessions.

Mutations and grant writes MUST be serialized or transactionally guarded so concurrent calls cannot reuse once approval or race registry replacement.

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

The general permission session is independent of workflow execution. The workflow `beforeTool` projection MUST call this subsystem or a compatibility wrapper over it. It MUST NOT maintain separate grant or permit semantics.

Adapters may hide a tool that is proven always denied, but every registered tool call that can still be invoked MUST pass through interception and permit enforcement.

## 11. Verification

Isolated automated tests MUST cover:

- duplicate rejection and atomic registry generations;
- resolver success, unresolved output, returned error, throw, empty output, and invalid output;
- multi-request deduplication and deny/ask/allow precedence;
- once, session, durable, expiring, revoked, and invalidated grants;
- project, agent, policy, registration revision, and generation isolation;
- challenge and permit replay, staleness, expiry, input swapping, and concurrent consumption;
- unresolved approval with and without UI;
- child approval relay without parent grant inheritance;
- registry replacement invalidation;
- Runtime Store failures and data-ban compliance;
- workflow `beforeTool` compatibility;
- complete native/Weave-owned inventory coverage and failure on a missing or bypassable registration;
- unmanaged third-party tools receiving no Weave permit.

Tests MUST use in-memory repositories, pure resolvers, and fake adapter ports. They MUST NOT start a real harness, child process, network request, or approval UI.

## 12. Non-goals

This contract does not standardize concrete tool names, harness discovery, approval widgets, RPC framing, or adapter process control. It does not grant Weave authority over unregistered third-party tools.
