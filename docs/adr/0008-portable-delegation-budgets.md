# ADR 0008 — Portable Delegation Budgets

**Status:** Accepted

**Related:** [Pi Adapter](../adapters/pi.md) · [DSL Reference](../reference/dsl.md) · [Adapter Boundary](../architecture/adapter-boundary.md)

## Context

Delegation consumes agent turns and, in some harnesses, child processes. If each adapter hard-codes its own limits, the same `.weave` configuration can create different cost, depth, and concurrency behavior across harnesses. Pi needs process limits, but those limits express product intent that also applies to adapters that use in-process or remote delegation.

The engine cannot count Pi processes or own a Pi queue. The adapter boundary requires adapters to supply live harness context while the engine makes harness-neutral policy decisions.

## Decision

Weave will model delegation limits as portable configuration.

Project settings define:

- `max_children`: hard cap on active direct children running in parallel per parent; settled or disposed children release capacity;
- `max_concurrency`: maximum concurrent children per parent before requests queue;
- `max_depth`: maximum delegation depth below the root;
- `max_processes`: maximum live delegated work units across the adapter.

Agents may narrow only `max_children` and `max_concurrency`. They may not raise project caps or override project-wide depth and process limits.

Core owns DSL syntax, validation, and defaults. Config owns layer merge. Engine owns `EffectiveDelegationLimits` and `authorizeDelegation()`, a pure decision over adapter-supplied counts. Adapters own queues, process or task counts, spawn, cancellation, and final enforcement.

The defaults are a hard cap of 9 active direct children, 3 concurrent children per parent before queuing, depth 3 below root, and 9 live work units globally. Validation uses bounded positive integers and precise field paths.

## Consequences

- A configuration carries the same delegation intent across harnesses.
- Adapters may implement limits with processes, tasks, or native subagents without exposing those details to the engine.
- Authorization is deterministic and testable without starting a harness.
- Adapters must keep live counts accurate and must fail closed when count state is unavailable.
- Agent overrides cannot weaken project-wide safeguards.

## Rejected alternatives

### Pi-only constants

This would hide user intent in one adapter and create divergent behavior across harnesses.

### Engine-owned process accounting

This would make the engine inspect harness state and violate the adapter boundary.

### Unlimited or zero-as-unlimited values

These values make failure and cost bounds unclear. The contract uses finite positive ranges only.
