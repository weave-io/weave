# Delegation Limits

Portable delegation limits bound fan-out, concurrency, depth, and live work across harnesses.

**Related:** [DSL Reference](dsl-reference.md#settings-block) · [ADR 0008](adr/0008-portable-delegation-budgets.md) · [Spec 33 §10](specs/33-spec-pi-adapter/33-spec-pi-adapter.md#10-portable-delegation-limits) · [Adapter Boundary](adapter-boundary.md)

## DSL

```weave
settings {
  delegation {
    max_children 9
    max_concurrency 3
    max_depth 3
    max_processes 9
  }
}

agent tapestry {
  delegation {
    max_children 3
    max_concurrency 2
  }
}
```

Project fields are optional. Omitted fields inherit lower config layers; after merge, unresolved fields use defaults `9`, `3`, `3`, and `9` respectively. Agent blocks may set only `max_children` and `max_concurrency`, and only to values at or below the merged project caps.

All values are positive safe integers. `max_children` is limited to `1..9`, and effective concurrency must not exceed effective children. When an agent narrows `max_children` without setting concurrency, effective concurrency is clamped to the narrower child cap.

## Merge behavior

Delegation blocks use normal object deep merge. Only fields authored in the higher-priority layer replace lower-priority values. This is why the core schema leaves omitted delegation fields absent instead of injecting per-layer defaults. `mergeConfigsResult()` validates the effective merged config and returns `ConfigValidationError` when an agent override exceeds a lower-layer project cap.

## Engine API

`resolveEffectiveDelegationLimits(config, agentName?)` returns `Result<EffectiveDelegationLimits, DelegationLimitsError>`. It resolves merged project intent and optional agent narrowing into camel-case runtime limits.

`authorizeDelegation(input)` accepts those limits plus adapter-supplied live counts:

- `directChildren` — direct children already created for this parent;
- `activeChildren` — currently active direct children;
- `childDepth` — proposed child's depth below root;
- `liveProcesses` — live delegated work units across the adapter.

The result is:

- `authorized` when the child may start;
- `queued` for temporary concurrency or global-process pressure;
- `denied` for exhausted direct-child capacity or excess depth.

Invalid or unsafe counts return a typed `InvalidDelegationCount` error. Adapters own count collection, queues, process/task creation, cancellation, and enforcement. The engine performs no harness discovery or process inspection.
