# Harness-neutral Permissions

Conceptual guide for agents and adapter authors. Normative contracts live in
[Spec 34](specs/34-spec-harness-neutral-permissions/34-spec-harness-neutral-permissions.md),
[ADR 0009](adr/0009-input-aware-tool-permission-authorization.md),
[Spec 12](specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md), and
[Spec 13](specs/13-spec-minimal-execution-lifecycle-surface/13-spec-minimal-execution-lifecycle-surface.md).
This page orients; it does not redefine those rules.

**Related:** [Adapter Boundary](adapter-boundary.md) · [Tool Policy Evaluation](tool-policy-evaluation.md) · [Engine package README](../packages/engine/README.md)

## Ownership

| Concern | Owner |
| --- | --- |
| Registry validation, sealed generations, request canonicalization | Engine |
| Effective-policy binding, grants, challenges, single-use permits | Engine |
| Durable grant repository, clock, opaque IDs, grant envelopes | Engine (internal) |
| Coverage proof over adapter-supplied inventories | Engine |
| Concrete tool discovery, runtime identities, pure resolvers | Adapter |
| Interception, approval UI/relay, permit consume-before-execute | Adapter |
| Mapping coverage failure to `tool-policy-mapping` readiness | Adapter |

The engine never discovers harness tools or names concrete harnesses beyond opaque
identities the adapter puts in the coverage context.

## Registry and service activation

1. Build registrations with `PermissionRegistryBuilder` (opaque tool identity,
   owner, semantic revision, bounded display, pure synchronous resolver).
2. Seal to an immutable `PermissionRegistryGeneration`. Seal mints a **fresh**
   opaque generation `id` that is not derived from metadata and is not
   caller-chosen. Replay of a previously observed generation id fails closed.
3. Activate with `createPermissionService(runtimeStore).activate({...})`.

Activation input is only:

- project identity
- controller session id
- sealed registry generation
- stable agent → effective-policy map
- request schema version

Adapters do **not** pass a repository, clock, ID source, grant record, identity
envelope, or per-call policy. The service loads the private repository through
an engine-internal store association and returns a branded `PermissionSession`.

There is no public construction-token / `fromToken` surface for generations.
Genuine session and generation instances, constructors, and prototypes are
frozen. Authoritative paths use module-private non-virtual accessors, not
attacker-replaceable own or prototype methods.

## Normalized requests

Resolvers return one or more `PermissionRequest` values:

- **Grantable** — `capability`, `operation`, `target`, optional canonical
  `constraints`, and separate sanitized `display`. Authorization fields alone
  form the identity digest; display never does.
- **Unresolved** — explicit non-grantable shape when supported input cannot be
  mapped safely. Always needs approval; only allow-once or reject; never creates
  session/durable grants; blocks when UI is unavailable.

Resolver output is snapshotted once via own data descriptors (prototype,
`ownKeys`, `length`, and each index) before emptiness or element validation.
Changing length/key/value proxies cannot turn deny requests into empty or
allowed authorize/consume results. Resolver throw, returned error, empty
output, invalid output, or unsafe input is a typed failure distinct from policy
denial. It yields no challenge or grant.

## Policy precedence

For each intercepted registered call the engine:

1. resolves and validates requests;
2. deduplicates exact requests;
3. evaluates every request against the bound agent policy;
4. applies **`deny` regardless of grants**;
5. satisfies **`allow` without a grant**;
6. matches a valid grant for **`ask`**, or opens a challenge;
7. authorizes only when **every** request is satisfied.

One denied request blocks the full call. Outcomes are exactly one of
`unmanaged`, `denied`, `approval_required`, or `authorized` (with a permit).
Registration, resolver, repository, and lifecycle failures sit outside that
outcome union.

Each `approval_required` pending request view is a frozen closed record that
retains its own identity plus evaluation fields even when the UI groups prompts:

| Field | Closed values | Meaning |
| --- | --- | --- |
| `decision` | `ask` | Only `ask` becomes pending; `deny` is a separate outcome |
| `source` | `policy` \| `resolver` | Grantable ask without grant vs unresolved mapping |
| `reason` | `policy_ask_without_grant` \| `unresolved_request` | Bounded why-pending label for UI/diagnostics |

Denied views stay presentation-only (no challenge `requestId`, no pending
evaluation fields).

## Challenge choices and scopes

Native UI may offer each grantable pending request:

| Choice | Scope | Lifetime |
| --- | --- | --- |
| Allow once | `once` | This call only (via permit) |
| Allow for this session | `session` | Until controller session close |
| Allow durably for this project | `durable` | Until revoke, expiry, or envelope invalidation |
| Reject | — | No grant; no hidden deny policy |

Unresolved requests accept only allow-once or reject. Durable grants have no
mandatory default expiry. Rejecting a prompt does not write deny policy; lasting
denial belongs in `.weave` config.

Grants match only inside the full identity envelope: project, agent, owner/tool,
registration revision, effective-policy fingerprint, request schema version, and
exact request digest. Children never inherit parent grants.

## Exact envelope and permits

Challenges expire after five minutes. Permits expire after 30 seconds, are
opaque and single-use, and bind project/session, agent, registry generation,
policy fingerprint, request keys or unresolved binding, the exact intercepted
call, expiry, and consumption state.

**Consume immediately before execution.** Changed input, wrong agent/session,
stale generation, changed policy, expiry, unknown identity, or replay must block
with a typed error. Partial multi-request approval never executes.

## Coverage proof and readiness

Before claiming required `tool-policy-mapping` readiness, adapters call
`verifyPermissionCoverage(context)` with:

- branded sealed generation
- native and Weave-owned inventories (must be registered and non-bypassably intercepted)
- intercepted and bypassable claims
- unmanaged third-party identities (may stay unregistered; no Weave permit)
- diagnostics policy (`includeToolIdentities`)

The helper snapshots plain own enumerable data once. Inventory arrays use the
same one-shot descriptor-based array snapshot as resolver output: prototype,
`Reflect.ownKeys`, own data `length`, and every indexed data descriptor are
captured exactly once; live length/indices are never reread. Getters, proxies,
extras, sparse/inconsistent arrays, disappearing identities, duplicates, and
set overlap fail as `invalid_coverage` (never zero-count readiness success).
Missing registration, missing interception, or bypassable required/registered
tools fail as `incomplete_coverage`. Success returns an immutable
`PermissionCoverageProof`. Adapters map either error to readiness failure.
Concrete interception wiring remains adapter-owned.

## Runtime Store migration v3 and data ban

Durable grants live only in migration-v3 `permission_grants` columns. Raw calls,
constraints, prompts, secrets, and token data are never persisted. Digests,
identity envelope, sanitized display, scope, and timestamps are allowed.

SQLite migration 3 creates or adopt-checks that table, then **re-verifies the
live schema** on every open at schema ≥ 3. Verification enforces an exact
`sqlite_schema` inventory for `permission_grants`: zero triggers; exactly the
SQLite PK autoindex on `grant_id`, the full-envelope UNIQUE autoindex, and the
named non-unique lookup index `idx_permission_grants_project_state_expiry`
(expected columns/order/non-partial). Extra unique, partial, or expression
indexes fail closed — the schema is code-owned and exact. Autoindex name
suffixes are not pinned across SQLite versions. Dropped or altered relations,
attached triggers, and unexpected indexes fail closed; `CREATE TABLE IF NOT
EXISTS` must not paper over a malformed or hostile table. Behavioral
CHECK/UNIQUE probes use randomized IDs inside a savepoint and do not claim
trigger-body analysis beyond the structural ban.

`RuntimeStore` still exposes only workflow, lease, snapshot, and journal
repositories. Memory and SQLite keep the permission repository private and
register it in an engine-only `WeakMap`. There is **no** public
`store.permissions` mutation surface and no package-root repository export.
Adapters use `PermissionService` only.

## `beforeTool` vs `previewToolPolicy`

| API | Role |
| --- | --- |
| Session `authorizeCall` / ordinary interception | General harness-neutral authorization |
| `beforeTool(RegisteredBeforeToolInput)` | Workflow lifecycle compatibility over the same session |
| `previewToolPolicy(...)` | Non-authoritative static allow/deny/ask preview |

`beforeTool` accepts only the registered call snapshot (exact plain own
enumerable shape). Legacy static policy fields, accessors, proxies, and extras
are lifecycle validation errors. There are **no** legacy `beforeTool` aliases
that reintroduce one-capability authorization.

Authoritative engine paths (including `beforeTool`) call the module-private
non-virtual authorize entry (`authorizePermissionSessionCall`), never dynamic
`session.authorizeCall` lookup. `previewToolPolicy` cannot authorize execution,
issue a permit, or establish adapter readiness.

## Permit consumption and execution snapshot

`PermissionSession.consumePermit` and the non-virtual
`consumePermissionSessionPermit` helper return
`ResultAsync<PermissionExecutionSnapshot, PermissionError>` — a deep-frozen
engine-owned JSON clone of the exact call validated during consume. Adapters
**must** execute only that returned snapshot. Authorization is not executable
without a successful snapshot return. Caller mutation after consume, live proxy
get traps, nested mutation, input swap, and permit replay must not change what
executes.

## Clocks and durable high-water

Sessions split clocks: a monotonic source owns challenge (5m) and permit (30s)
deadlines; a wall source owns audit timestamps and durable grant createdAt/
expiry. Production `PermissionService` injects a steady `performance.now`
monotonic clock and `Date.now` wall clock. Both maintain nondecreasing
high-water marks so source rollback cannot extend TTL. Durable repositories
observe wall time on every save/match/list and on every revoke of a known
in-project grant (including already-revoked idempotent revokes) and keep a
private high-water (SQLite: `runtime_metadata.permission_wall_clock_high_water`).
Revoke observes high-water **before** the already-revoked early return so a
second revoke at a later wall time still raises the mark; unknown/wrong-project
revokes do **not** observe (no high-water poisoning via random IDs). SQLite
updates the mark under `BEGIN IMMEDIATE` with bounded busy retry across store
instances and a max-preserving UPSERT so concurrent observations never lose the
global max. Once a grant is observed expired it stays ineligible after wall
rollback and SQLite reopen. High-water is not a public API.

Unregistered tools remain `unmanaged`, never `allow`.

## Public / internal boundary

**Package-root public surface (illustrative):**
`PermissionRegistryBuilder`, `PermissionRegistryGeneration`,
`createPermissionService` / `PermissionService`, branded `PermissionSession`,
normalized request/outcome/challenge/permit/admin view types,
`verifyPermissionCoverage` and its proof/error types, plus lifecycle
`beforeTool` / `previewToolPolicy`.

**Internal (not adapter-facing):** permission repository implementations,
grant records and identity envelopes, clocks, ID sources, hydration helpers,
construction/testing hooks, store association accessors, non-virtual session
and generation accessors.

## Closed errors

Permission failures use a closed `PermissionError` union (invalid/duplicate
registration, invalid registry transition, non-idle replacement, resolver
failures, unsafe/invalid/empty output, repository failure, stale/unknown/
expired/consumed challenge or permit, invalid scope/response, closed or
mismatched session, unresolved UI unavailable, capacity exceeded, and related
variants). Coverage uses `invalid_coverage` | `incomplete_coverage`. Lifecycle
validation failures stay on the lifecycle error union.

Adapters block on every permission error. Diagnostics may carry registration
identity, agent, category, and generation id — never raw call input, constraints,
secrets, or approval digests.

## Test pointers

Isolated engine tests (no real harness, network, or UI):

| File | Focus |
| --- | --- |
| `packages/engine/src/__tests__/permissions-registry.test.ts` | Builder, seal, fresh ids, duplicate rejection |
| `packages/engine/src/__tests__/permission-session.test.ts` | Authorize, grants, challenges, permits, replacement |
| `packages/engine/src/__tests__/permission-session-security.test.ts` | Brands, freeze, non-virtual authority, forgery |
| `packages/engine/src/__tests__/permission-service.test.ts` | Service activation boundary |
| `packages/engine/src/__tests__/permissions-canonical.test.ts` | Request canonicalization and display sanitization |
| `packages/engine/src/__tests__/permissions-repository.test.ts` | In-memory/SQLite grant repository contract |
| `packages/engine/src/__tests__/runtime-permissions.test.ts` | Migration v3, live schema verification, data ban |
| `packages/engine/src/__tests__/permissions-coverage.test.ts` | Coverage proof and fake-adapter snapshot execution |
| `packages/engine/src/__tests__/permission-session.test.ts` | Consume snapshot freeze; monotonic/wall rollback |
| `packages/engine/src/__tests__/runtime-permissions.test.ts` | Durable high-water, reopen under lower wall clock |
| `packages/engine/src/__tests__/permissions-before-tool.test.ts` | Registered `beforeTool`, no legacy aliases |
| `packages/engine/src/__tests__/public-api.test.ts` | Root export surface |

Static policy composition remains under
`packages/engine/src/__tests__/tool-policy.test.ts` and does not prove call
authorization.
