# ADR 0011 — Effective Adapter Readiness and Runtime Observability

**Status:** Accepted

**Related:** [Adapter Capabilities](../reference/adapter-capabilities.md) · [Runtime Store](../reference/runtime.md) · [Pi Adapter](../adapters/pi.md)

## Context

A static capability declaration says what an adapter was built to support, not what the current host, project, and runtime can support now. Claiming readiness without probing the installed host risks executing through missing hooks or incompatible behavior.

Runtime journals and logs can also grow without bound. Usage events may be retried, and diagnostic payloads can leak prompts, secrets, tool input, or child-control credentials unless the contract bans them explicitly.

## Decision

Static capability declarations are ceilings. Each adapter must run exactly one effective probe for every capability during activation. A probe may preserve or lower the declared level; it may never raise it. Missing, failed, contradictory, or stale probe data makes that capability unavailable.

If any required capability is degraded or unsupported, the adapter enters health-only mode. Health-only mode exposes diagnostics and safe inspection, but blocks materialization, delegation, workflow mutation, and governed tool execution. Host package identity and supported version range are readiness inputs and fail closed.

The Runtime Store will add bounded retention settings for workflow journals, usage detail, and adapter recovery entries. Journal pruning runs through the same serialized mutation path as append and removes entries by age before count.

Usage recording will use idempotent observation identities. Durable rollups are updated atomically with detailed observations. Pruning detail never subtracts historical rollups.

Adapters may keep correlation-only recovery pointers in harness session entries. These pointers never authorize resume; engine Runtime Store state and explicit user intent do.

Adapters will use child-scoped pino loggers and bounded sanitized fields. Prompts, responses, tool inputs/outputs, normalized authorization constraints, approval material, environment values, session transcripts, child HMAC secrets, and raw RPC payloads are forbidden from journals and structured logs.

## Consequences

- Readiness reports describe the active host rather than package intent alone.
- Required runtime gaps stop work before partial execution can corrupt state.
- Diagnostics remain available when execution is disabled.
- Usage retries do not double count.
- Retention bounds disk growth while preserving monotonic aggregate usage.
- Recovery correlation cannot become a hidden authorization path.

## Rejected alternatives

### Trust static declarations

This cannot detect missing host hooks, incompatible versions, or project-specific failures.

### Let probes upgrade declarations

A runtime probe cannot add code the adapter did not declare and ship.

### Use Pi session entries as recovery authority

Harness entries may be copied, stale, or user-selected. Resume authority must remain in engine state and explicit user action.
