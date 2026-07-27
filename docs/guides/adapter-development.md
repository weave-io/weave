# Develop an Adapter

An adapter translates normalized Weave intent into one harness. It owns harness discovery and registration; it does not fork the DSL, prompt composer, workflow model, or runtime state machine.

Read [Adapter Boundary](../architecture/adapter-boundary.md) before starting.

---

## 1. Define the harness boundary

List the concrete services the adapter needs and inject them through narrow ports:

- project trust and root resolution;
- model catalog and selected model;
- skill discovery and file loading;
- tool inventory and authorization hooks;
- agent/config materialization;
- command, event, status, and UI registration;
- child task/process control;
- plan and artifact file access;
- logging destination.

Keep harness SDK types inside the adapter package. Engine calls receive normalized objects only.

## 2. Declare capabilities

Build one `AdapterCapabilityContract` using the closed IDs in [`packages/engine/src/capability-contract.ts`](../../packages/engine/src/capability-contract.ts).

A declaration is a static ceiling, not proof that the current host can support it. Explain the real implementation path and the impact of degradation. Do not claim Weave enforcement when the harness or tool owner actually controls authorization.

See [Adapter Capabilities](../reference/adapter-capabilities.md).

## 3. Probe the current host safely

The initializer supplies exactly one runtime probe per capability. A probe:

- performs no project mutation;
- makes no outbound network request;
- does not start work or register user-visible surfaces;
- returns bounded safe evidence;
- may lower static readiness, never raise it.

A missing or inadequate required probe yields health-only mode. Health-only mode may expose diagnostics, but it must not materialize agents, mutate workflow state, or delegate.

Re-run probes for every controller or plugin generation. Do not reuse readiness across a hot reload.

## 4. Load Weave config

Use `@weaveio/weave-config` for builtin, global, and trusted project layers. Never parse `.weave` or reimplement merge semantics in the adapter.

Project trust is adapter context because only the harness knows whether project-local files may be read. Pass that decision into config loading explicitly.

See [Configuration](../reference/configuration.md).

## 5. Supply model and skill context

The adapter discovers harness resources:

```ts
const availableModels = await modelPort.listAvailable();
const selectedModel = await modelPort.selected();
const availableSkills = await skillPort.loadAvailable();
```

Pass these normalized values to engine resolution helpers. The engine returns intent; the adapter activates or projects it.

- Do not scan harness directories from engine code.
- Do not put a harness client on `HarnessAdapter` merely to make discovery convenient.
- Do not silently choose a model or skill that the engine did not resolve.

See [Models](../reference/models.md) and [Adapter Boundary](../architecture/adapter-boundary.md#normalized-data-flows).

## 6. Materialize agents

Ask the engine for a `MaterializationPlan`. Process entries in plan order:

1. report typed descriptor failures;
2. translate each valid descriptor into the harness's agent/config shape;
3. preserve logical name, mode, composed prompt, model intent, skills, category metadata, and tool policy;
4. register or write the concrete artifact;
5. retain adapter-private handles outside the descriptor.

Do not rebuild prompts, reinterpret category inheritance, reorder descriptors, or invent fallback agents.

## 7. Register an explicit execution surface

A durable execution starts only through an adapter-native command, tool, or equivalent authorized surface. Passive hooks and ordinary chat are observations, not execution entrypoints.

Map the concrete request to one of the engine operation kinds:

- `start`
- `resume`
- `pause`
- `inspect`
- `advance`

The adapter supplies the authorization source and safe normalized context. The engine validates state and returns typed effects. See [Execution Lifecycle](../reference/execution-lifecycle.md).

## 8. Map lifecycle events

Adapters register harness callbacks and call engine lifecycle functions. The engine never receives or registers a concrete callback.

Typical mappings:

| Harness event | Engine projection |
| --- | --- |
| Session snapshot or idle observation | `observeSession` |
| User starts work | `startExecution` |
| User resumes work | `resumeExecution` |
| User interrupts active work | `handleUserInterrupt` |
| Adapter is ready to run a step | `dispatchStep` |
| Child settles with structured output | `completeStep` |
| Registered tool call | `beforeTool` |
| Status view | `inspectExecution` |
| Artifact approval action | `approveArtifact` |
| Mismatch or gate rejection | `reconcileExecution` |

The adapter translates returned effects into harness behavior. It records one structured completion candidate and waits for harness settlement before calling `completeStep`.

## 9. Implement plan and artifact ports

The engine owns semantics; the adapter owns concrete file access.

A provider must:

- prove paths stay inside the trusted project root;
- reject symlink escapes and ambiguous paths;
- use Bun file APIs;
- return typed errors;
- compute SHA-256 artifact digests when asked;
- never place artifact contents in runtime metadata or logs.

Use the engine's `PlanStateProvider` contract rather than teaching engine code about a harness plan format.

## 10. Map tools and permissions honestly

Tool-policy preview is not authorization. For intercepted registered tools, call `beforeTool` with normalized input and enforce its decision. For harness-native or tool-owner authorization, name that ownership in the capability declaration instead of claiming a Weave permit path.

Unknown or unregistered tools return `unmanaged`; they do not inherit an invented decision.

See [Tool Policy](../reference/tool-policy.md) and [Permissions](../reference/permissions.md).

## 11. Route logs away from the UI

Use the shared pino logger from `@weaveio/weave-engine`. Add an adapter child binding and choose a destination that will not corrupt a TUI or plugin protocol.

An adapter may route logs to a project file or a harness log channel. It must not use `console.*`.

## 12. Test the boundary

Every adapter module that owns state or coordinates components needs an isolated test. Replace all external boundaries:

- harness SDK → minimal fake host;
- `Bun.file` reads → string fixtures or an injected port;
- `Bun.spawn` → controlled process port;
- network clients → in-memory stubs;
- Runtime Store → in-memory implementation.

Do not launch a real harness in unit or integration tests. Packed-artifact and live-smoke checks belong to release validation, not the unit suite.

See [Testing](../contributing/testing.md).

## 13. Document only current behavior

Add or update one page under [`docs/adapters/`](../adapters/) and the public docs if users see the change. State capability gaps directly. Keep task plans, proof captures, and rollout status in the issue, pull request, or CI artifacts.

## Review checklist

- [ ] No harness SDK type crosses into engine code.
- [ ] Config, prompt, model, skill, workflow, and policy logic reuse engine/config APIs.
- [ ] Static capabilities and runtime probes describe the real host.
- [ ] Required probe gaps enter health-only mode.
- [ ] Durable execution has an explicit user-visible entrypoint.
- [ ] Lifecycle effects, plans, artifacts, and permissions fail closed.
- [ ] Sensitive or raw harness data never enters metadata, errors, logs, or Runtime Store rows.
- [ ] Tests mock every harness, process, filesystem, and network boundary.
- [ ] Adapter and public docs describe the behavior that exists now.
