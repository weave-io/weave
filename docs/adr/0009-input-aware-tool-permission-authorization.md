# ADR 0009 — Input-aware Tool Permission Authorization

**Status:** Accepted

**Related:** [Permissions](../reference/permissions.md) · [Runtime Store](../reference/runtime.md) · [Execution Lifecycle](../reference/execution-lifecycle.md) · [Pi Adapter](../adapters/pi.md) · [Tool Policy](../reference/tool-policy.md) · [Adapter Boundary](../architecture/adapter-boundary.md)

## Context

The existing `beforeTool` path evaluates one adapter-selected capability. It cannot distinguish two calls to the same tool by operation, target, or constraints. It also cannot safely remember approvals or prove that an approved call is the call that executes.

Concrete tool names, input shapes, interception hooks, and approval UI differ by harness. Effective policy, approval scope, replay protection, and grant isolation are portable Weave semantics.

## Decision

Weave will add an engine-owned, harness-neutral permission subsystem with these public roles:

- `PermissionRegistryBuilder`;
- immutable `PermissionRegistryGeneration`;
- `PermissionService`, which creates branded `PermissionSession` handles;
- sanitized permission request, outcome, and administration contracts;
- `verifyPermissionCoverage`, a pure inventory/interception proof helper that accepts adapter-supplied native, Weave-owned, intercepted, bypassable, and unmanaged third-party identities against a sealed generation.

The Runtime Store exposes workflow, lease, snapshot, and journal repositories only. Memory and SQLite stores associate their private durable permission repository with the store through an engine-internal `WeakMap`; adapters cannot receive or mutate that repository.

Adapters register trusted concrete tools with opaque runtime identity, owner identity, semantic revision, bounded display metadata, and a pure synchronous input resolver. The resolver returns one or more normalized permission requests or an explicit non-grantable `unresolved` request.

The engine validates and canonicalizes requests, binds them to the session's effective agent policy, evaluates every request conjunctively, manages approval challenges and reusable grants, and issues short-lived single-use permits. Authorization fields determine identity; display text never does. Sealed registry generations receive fresh non-replayable opaque ids distinct from metadata identity. Genuine session/generation instances and prototypes are frozen; authoritative authorization and coverage paths use module-private non-virtual accessors.

Policy `deny` always wins. Policy `allow` needs no grant. Policy `ask` requires an exact matching grant or explicit approval. Every request must pass before a call can execute.

Adapters discover and intercept tools, supply resolvers, render or relay approval UI, and consume the permit immediately before execution. Unregistered tools are `unmanaged`: Weave makes no allow claim and issues no permit. Before claiming required tool-policy readiness, adapters call `verifyPermissionCoverage` with explicit inventories; the engine never discovers harness tools. Coverage failure (`invalid_coverage` / `incomplete_coverage`) maps to required capability readiness failure. Concrete registered-tool enforcement wiring remains an adapter task.

Durable grants persist only through Runtime Store migration v3 `permission_grants` with live schema re-verification on open; raw calls, constraints, prompts, secrets, and tokens are data-banned. There is no public repository or `store.permissions` surface.

The workflow `beforeTool` operation becomes a compatibility path over this general permission session rather than a second policy system. Legacy one-capability `beforeTool` aliases are not part of the public contract; static intent stays on non-authoritative `previewToolPolicy`.

## Security properties

Grants are isolated by project, agent, owner/tool identity, semantic revision, policy fingerprint, request schema version, and exact request digest. Challenges and permits bind the exact intercepted call, registry generation, session, agent, policy, expiry, and consumed state.

Resolver throw, error, empty output, invalid output, unsafe input, stale state, unavailable UI, or permit replay blocks execution with a typed error. Raw tool inputs, canonical constraints, secrets, and approval digests do not enter logs or durable metadata.

## Consequences

- Policy can distinguish read targets, commands, network destinations, and other security-relevant input.
- Approval memory remains portable while concrete resolution and UI remain adapter-owned.
- Multi-request calls fail closed if any request fails.
- Registry replacement must be idle-only and atomic; it invalidates outstanding challenges and permits and rejects observed-generation replay.
- Existing static policy helpers remain useful but no longer prove full call authorization.
- Adapter authors should start from the [Permissions guide](../reference/permissions.md); permission contract remains normative.

## Rejected alternatives

### Extend `beforeTool` with Pi fields

This would couple an engine contract to one harness and leave ordinary non-workflow calls uncovered.

### Let adapters generate approval keys

Opaque adapter keys cannot prove canonical identity or safe cross-session isolation.

### Treat unknown tools as allowed

This would claim enforcement Weave did not perform. `unmanaged` preserves the owning extension's behavior without issuing a permit.
