# Execution Lifecycle

The execution lifecycle is the engine-owned contract that adapters use to observe sessions, drive workflow execution, enforce policy, and return abstract effects. Adapters map concrete harness events into normalized inputs; the engine never registers harness callbacks itself.

**Related:** [Runtime Store](runtime.md) · [Workflows](workflows.md) · [Permissions](permissions.md) · [Adapter Boundary](../architecture/adapter-boundary.md) · [ADR 0004](../adr/0004-workflow-first-execution-contract.md)

---

## Boundary

An adapter may inspect its harness, map an event, and call a lifecycle function. A lifecycle function may validate policy, update the Runtime Store, and return a typed result or an abstract effect. The adapter then translates that effect back into harness behavior.

Lifecycle inputs contain normalized identifiers and safe metadata. They never carry raw harness payloads, prompts, credentials, transcripts, provider-private data, or harness-owned paths.

## Surface

The current public surface has ten lifecycle projections:

| Function | Responsibility |
| --- | --- |
| `observeSession` | Record a sanitized, normalized session observation |
| `startExecution` | Create an execution and acquire its lease |
| `resumeExecution` | Rebind to an execution under lease rules |
| `handleUserInterrupt` | Pause active work without making it terminal |
| `dispatchStep` | Resolve the runnable step and return an abstract dispatch effect |
| `completeStep` | Validate a structured completion and advance or settle state |
| `beforeTool` | Authorize a registered tool call through a permission session |
| `inspectExecution` | Read a point-in-time snapshot without mutation |
| `approveArtifact` | Apply revision-bound artifact approval policy |
| `reconcileExecution` | Route an authorized reconciliation reason to its handler |

`previewToolPolicy` is a separate static preview. It reports `allow` / `deny` / `ask` intent but cannot authorize a call, issue a permit, or prove adapter readiness.

The barrel is [`packages/engine/src/execution-lifecycle/index.ts`](../../packages/engine/src/execution-lifecycle/index.ts). Inputs, outputs, effects, and errors are in [`types.ts`](../../packages/engine/src/execution-lifecycle/types.ts).

## Explicit execution operations

Only five operation kinds drive or inspect durable execution state:

- `start`
- `resume`
- `pause`
- `inspect`
- `advance`

Starting or advancing work requires an explicit adapter-native command or another authorized product surface. Ordinary chat does not silently start a workflow.

`observeSession` is a passive observation. `beforeTool` is an authorization projection. Neither may start or advance execution.

## Effects

Lifecycle functions return normalized effects instead of calling a harness directly:

- dispatch an agent;
- pause execution;
- complete execution.

Effects contain only the agent, workflow, step, and decision data the adapter needs. Harness process IDs, UI objects, private child-session state, and concrete callbacks stay in the adapter.

## Completion

Free-form prose and process exit are not completion signals. An adapter records one valid structured completion candidate, waits for harness settlement, then calls `completeStep`.

Missing, duplicate, malformed, rejected, or late candidates fail without advancing state. Completion may advance to another step, pause, block, fail, or make the workflow terminal.

## Leases and recovery

`startExecution` and `resumeExecution` use the Runtime Store lease model. A live foreign lease returns a typed conflict. Recovery takeover is explicit and separate from ordinary resume; adapter-private child recovery does not grant an engine execution lease.

## Artifacts

Artifact approval binds an actor to a specific artifact identity and revision. A new revision resets approval. Dispatch verifies required inputs, their roles, consumed revisions, and integrity metadata before work proceeds.

- **Normative** inputs constrain downstream behavior.
- **Informational** inputs may inform work but cannot override normative inputs.
- Adapters compute file digests; the engine compares them with stored integrity metadata without reading artifact contents.

## Reconciliation

The built-in reconciliation reasons form a closed set:

- `execution-mismatch`
- `user-revision-request`
- `review-rejection`
- `security-rejection`

Each reason has an authorized source. The runtime resolves the nearest workflow step that explicitly declares it handles that reason. If no handler exists, execution pauses or blocks rather than guessing.

## Errors and testing

Lifecycle failures use the `LifecycleError` discriminated union: validation, not found, lease conflict, persistence, or policy decision. All fallible operations return `ResultAsync`.

Tests use an in-memory Runtime Store and mock adapters; they never launch a real harness. See [`packages/engine/src/__tests__/execution-lifecycle.test.ts`](../../packages/engine/src/__tests__/execution-lifecycle.test.ts) and [`execution-lifecycle-integration.test.ts`](../../packages/engine/src/__tests__/execution-lifecycle-integration.test.ts).
