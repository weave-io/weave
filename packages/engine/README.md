# `@weaveio/weave-engine`

Harness-agnostic composition, policy, lifecycle, and runtime-state APIs for Weave.

The engine consumes validated `WeaveConfig` intent plus explicit harness context supplied by adapters. It returns normalized descriptors, decisions, and abstract effects without knowing how a concrete harness stores models, discovers skills, registers callbacks, renders UI, or starts child work.

See [Adapter Boundary](../../docs/architecture/adapter-boundary.md) before adding an API.

## Ownership

The engine owns:

- agent descriptors and ordered materialization plans;
- prompt template context and composition;
- model intent and skill matching against adapter-supplied candidates;
- portable delegation budgets;
- abstract tool policy and input-aware permission decisions;
- capability schemas, probe lowering, and health reports;
- workflow lifecycle transitions and abstract effects;
- Weave-owned runtime state under `.weave/runtime/**`;
- plan-state interfaces, artifact metadata, review orchestration, and reconciliation.

Adapters own harness discovery, concrete tool names, plugin/extension hooks, command and UI registration, process spawning, model activation, skill files, and plan/artifact file I/O.

## Module map

| Module | Responsibility |
| --- | --- |
| `adapter.ts` | Minimal `HarnessAdapter` seam |
| `descriptors.ts` | Normalized `AgentDescriptor` construction |
| `materialization.ts` | Ordered plans and typed per-descriptor failures |
| `compose.ts` | Prompt composition orchestration |
| `template-context.ts`, `template-renderer.ts` | Mustache context and rendering |
| `model-resolution.ts` | Pure ordered model-intent resolution |
| `skill-resolution.ts` | Pure skill matching and disable filtering |
| `delegation-limits.ts` | Portable child/depth/process authorization |
| `capability-contract.ts` | Static ceilings, runtime probes, readiness, health |
| `tool-policy.ts` | Abstract capability policy evaluation |
| `permissions/` | Requests, grants, challenges, permits, coverage |
| `execution-lifecycle/` | Normalized operations, transitions, and effects |
| `runtime/` | SQLite/in-memory store, journal, usage, retention, logging |
| `runtime-command-operations/` | Harness-neutral start/run/status/abort/advance operations |
| `plan-state-provider.ts` | Adapter-provided plan-state port |
| `review-orchestration.ts`, `review-variants.ts` | Review routing and model variants |

The public barrel is [`src/index.ts`](src/index.ts).

## Boundary shape

A typical engine helper accepts explicit normalized context:

```ts
const resolved = resolveAdapterModelIntent({
  agentName: descriptor.name,
  agentMode: descriptor.mode,
  agentModels: descriptor.models,
  uiSelectedModel,
  availableModels,
  systemDefault,
});
```

The adapter discovers `uiSelectedModel` and `availableModels`; the engine only resolves intent.

The same pattern applies to skills, capabilities, lifecycle events, plans, artifacts, and permission inventories. Engine code never scans a harness directory or queries a harness SDK.

## Execution lifecycle

Adapters map concrete events into these engine projections:

- `observeSession`
- `startExecution`
- `resumeExecution`
- `handleUserInterrupt`
- `dispatchStep`
- `completeStep`
- `beforeTool`
- `inspectExecution`
- `approveArtifact`
- `reconcileExecution`

`previewToolPolicy` is a non-authoritative static preview. It cannot authorize a call or establish adapter readiness.

See [Execution Lifecycle](../../docs/reference/execution-lifecycle.md), [Workflows](../../docs/reference/workflows.md), and [Permissions](../../docs/reference/permissions.md).

## Runtime Store

The engine may perform I/O only for Weave-owned runtime state. The default store is `.weave/runtime/weave.db`; adapters call repository and lifecycle APIs rather than receiving a database mutation surface.

See [Runtime Store](../../docs/reference/runtime.md).

## Failure contract

Fallible engine APIs return `Result` or `ResultAsync` with explicit discriminated-union errors. Expected failures never throw. See [TypeScript Conventions](../../docs/contributing/typescript.md).

## Tests

Engine tests inject adapter context and use the in-memory Runtime Store or focused fakes. Reuse [`src/__tests__/mock-adapter.ts`](src/__tests__/mock-adapter.ts). Never launch a real harness, write developer config, or call external services.

```bash
bun test packages/engine
```

See [Testing](../../docs/contributing/testing.md).
