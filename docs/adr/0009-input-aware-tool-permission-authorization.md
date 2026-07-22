# ADR 0009 — Input-aware Tool Permission Authorization

**Status:** Accepted

**Related:** [Spec 34 — Harness-neutral permission subsystem](../specs/34-spec-harness-neutral-permissions/34-spec-harness-neutral-permissions.md) · [Spec 33 — Full-readiness Pi adapter](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md) · [Tool Policy Evaluation](../tool-policy-evaluation.md) · [Adapter Boundary](../adapter-boundary.md)

## Context

The existing `beforeTool` path evaluates one adapter-selected capability. It cannot distinguish two calls to the same tool by operation, target, or constraints. It also cannot safely remember approvals or prove that an approved call is the call that executes.

Concrete tool names, input shapes, interception hooks, and approval UI differ by harness. Effective policy, approval scope, replay protection, and grant isolation are portable Weave semantics.

## Decision

Weave will add an engine-owned, harness-neutral permission subsystem with four public roles:

- `PermissionRegistryBuilder`;
- immutable `PermissionRegistryGeneration`;
- `PermissionSession`;
- `PermissionApprovalRepository` on the Runtime Store.

Adapters register trusted concrete tools with opaque runtime identity, owner identity, semantic revision, bounded display metadata, and a pure synchronous input resolver. The resolver returns one or more normalized permission requests or an explicit non-grantable `unresolved` request.

The engine validates and canonicalizes requests, binds them to the session's effective agent policy, evaluates every request conjunctively, manages approval challenges and reusable grants, and issues short-lived single-use permits. Authorization fields determine identity; display text never does.

Policy `deny` always wins. Policy `allow` needs no grant. Policy `ask` requires an exact matching grant or explicit approval. Every request must pass before a call can execute.

Adapters discover and intercept tools, supply resolvers, render or relay approval UI, and consume the permit immediately before execution. Unregistered tools are `unmanaged`: Weave makes no allow claim and issues no permit.

The workflow `beforeTool` operation becomes a compatibility path over this general permission session rather than a second policy system.

## Security properties

Grants are isolated by project, agent, owner/tool identity, semantic revision, policy fingerprint, request schema version, and exact request digest. Challenges and permits bind the exact intercepted call, registry generation, session, agent, policy, expiry, and consumed state.

Resolver throw, error, empty output, invalid output, unsafe input, stale state, unavailable UI, or permit replay blocks execution with a typed error. Raw tool inputs, canonical constraints, secrets, and approval digests do not enter logs or durable metadata.

## Consequences

- Policy can distinguish read targets, commands, network destinations, and other security-relevant input.
- Approval memory remains portable while concrete resolution and UI remain adapter-owned.
- Multi-request calls fail closed if any request fails.
- Registry replacement must be idle-only and atomic; it invalidates outstanding challenges and permits.
- Existing static policy helpers remain useful but no longer prove full call authorization.

## Rejected alternatives

### Extend `beforeTool` with Pi fields

This would couple an engine contract to one harness and leave ordinary non-workflow calls uncovered.

### Let adapters generate approval keys

Opaque adapter keys cannot prove canonical identity or safe cross-session isolation.

### Treat unknown tools as allowed

This would claim enforcement Weave did not perform. `unmanaged` preserves the owning extension's behavior without issuing a permit.
