# Adapter Boundary

Weave is a harness-agnostic orchestration framework with two cooperating halves:

1. **Core Weave API** (`@weave/core`, `@weave/config`, `@weave/engine`) parses DSL config, normalizes agent intent, resolves/composes prompt and policy data, and exposes pure helper APIs.
2. **Adapters** (`@weave/adapter-opencode`, `@weave/adapter-pi`, etc.) enable Weave inside a concrete harness by discovering harness-owned resources, translating normalized intent, and filling feature gaps when the harness lacks native support.

**Related:** [Product Vision](product-vision.md) · [Claude Code Adapter](claude-code-adapter.md) · [Model Resolution](model-resolution.md) · [Config Loading](config-loading.md) · [Prompt Composition](prompt-composition.md) · [Tool Policy Evaluation](tool-policy-evaluation.md) · [Runtime Persistence Spec](specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md) · [ADR 0002 — Runtime Persistence Store](adr/0002-runtime-persistence-store.md) · [Spec 05 — Skill Resolution](specs/05-spec-skill-loader/05-spec-skill-loader.md) · [Spec 07 — Adapter Capability Contract](specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md) · [Spec 08 — Abstract Tool Policy Evaluation](specs/08-spec-abstract-tool-policy-evaluation/08-spec-abstract-tool-policy-evaluation.md) · [Spec 09 — Adapter-Provided Skill Resolution](specs/09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md) · [Spec 14 — Stable Adapter Descriptor Contract](specs/14-spec-stable-adapter-descriptor-contract/14-spec-stable-adapter-descriptor-contract.md) · [Execution Lifecycle Surface](#execution-lifecycle-surface) · [Legacy Architecture](legacy-architecture.md)

---

## Boundary Rule

The key question is not "does the engine call the adapter?" The key question is:

> **Is the engine making a harness-specific assumption?**

Engine-to-adapter calls are acceptable when they use abstract, harness-agnostic intent. They are incorrect when they require the engine to know where a harness stores resources, how a harness registers lifecycle callbacks, or how a harness represents runtime state.

---

## Ownership Matrix

| Concern                                            | Owner                    | Why                                                                     |
| -------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `.weave` DSL parsing                               | Core (`@weave/core`)     | The DSL is Weave's source of truth                                      |
| Builtin/global/project config merge                | Config (`@weave/config`) | Config files are Weave-owned inputs                                     |
| Prompt file path resolution for `.weave/prompts/`  | Config (`@weave/config`) | Prompt files are part of Weave config layers                            |
| Prompt composition                                 | Engine (`@weave/engine`) | Composition should be reusable and harness-agnostic                     |
| Category shuttle descriptor generation             | Engine (`@weave/engine`) | Category shuttles are part of normalized delegation topology            |
| Model intent resolution helper                     | Engine (`@weave/engine`) | Pure helper; adapter supplies harness context                           |
| Available model discovery                          | Adapter                  | Model registries and UI state are harness-specific                      |
| Skill discovery/loading                            | Adapter                  | Skill locations and formats are harness-specific                        |
| Skill matching/filtering                           | Engine (`@weave/engine`) | Pure resolution against `AgentConfig.skills` and `disabled.skills`      |
| `.weave/runtime/**` Runtime Store                  | Engine (`@weave/engine`) | Runtime records are Weave product state, not harness resources          |
| Harness plugin/config generation                   | Adapter                  | Output format is harness-specific                                       |
| Concrete tool names and permissions                | Adapter                  | Tool identifiers differ by harness                                      |
| Runtime lifecycle event mapping                    | Adapter                  | Event names and payloads differ by harness                              |
| Abstract policy/lifecycle decisions                | Engine (`@weave/engine`) | Policy composition should be harness-neutral                            |
| Feature-gap emulation (subagents, hooks, commands) | Adapter                  | Missing capability must be implemented in the harness integration layer |

---

## Correct Data Flow Examples

### Model Resolution

Adapters discover harness model context, then call Weave's pure helper:

```ts
const resolved = resolveAdapterModelIntent({
  agentName: "loom",
  agentMode: agent.mode,
  agentModels: agent.models,
  uiSelectedModel: await adapterContext.getSelectedModel(),
  availableModels: await adapterContext.getAvailableModels(),
  systemDefault: adapterContext.defaultModel,
});
```

Weave does **not** query the harness UI or model registry itself.

### Skill Resolution

Adapters discover and load harness skills, then pass them to Weave:

```ts
const availableSkills = await adapterContext.loadAvailableSkills();
const resolvedSkills = resolveSkillsForAgent({
  agentName: "loom",
  agentSkills: agent.skills ?? [],
  availableSkills,
  disabledSkills: config.disabled.skills,
});
```

Weave does **not** scan `~/.weave/skills/`, `.weave/skills/`, OpenCode skill directories, Pi skill directories, or Claude Code skill directories. Those conventions belong to adapters.

### Runtime Store

The engine owns durable Weave runtime state under `.weave/runtime/**`, including the default `.weave/runtime/weave.db` Runtime Store described in [ADR 0002](adr/0002-runtime-persistence-store.md).

This is a narrow boundary exception: the engine may perform Bun filesystem/database I/O only for Weave-owned runtime records. It must not inspect harness-owned storage, harness session internals, harness model registries, or concrete harness plugin state. Adapters may emit sanitized observations through an engine-provided Runtime Journal writer, but adapters do not receive direct database ownership.

### Lifecycle Policies

Adapters map harness-specific events into Weave's abstract lifecycle/policy surface:

```ts
const effects = policySurface.onSessionIdle({
  sessionId: harnessEvent.session.id,
  activeAgent: adapterState.activeAgent,
  now: adapterClock.now(),
});

await adapterRuntime.applyEffects(effects);
```

Weave should not register OpenCode hooks, Pi extension callbacks, or Claude Code runtime handlers directly.

---

## Anti-Patterns

Do not add engine code that reaches into harness-specific state:

```ts
// ❌ Wrong: core engine discovers harness skills itself.
const skills = await scanOpenCodeSkillDirectories(projectRoot);

// ❌ Wrong: core engine queries a harness UI state API.
const selected = await opencodeClient.model.selected();

// ❌ Wrong: core engine registers a concrete harness hook.
opencodePlugin.on("session.idle", handler);
```

Prefer adapter-provided context and pure engine helpers:

```ts
// ✅ Correct: adapter supplies context; engine resolves intent.
const skills = await adapterContext.loadAvailableSkills();
const resolved = resolveSkillsForConfig(config, skills);
```

---

## Adapter-Provided Skill Resolution

Skill resolution is implemented as a pure engine helper. Adapters discover and load skills from harness-specific directories; the engine matches, filters, and validates those skills against agent config.

**Transitional adapter surface decision (Spec 09):** The `HarnessAdapter` interface exposes `loadAvailableSkills(): Promise<SkillInfo[]>`. This method is called by `WeaveRunner` before agent materialization. Adapters return a flat list of `SkillInfo` descriptors; the engine calls `resolveSkillsForConfig()` and attaches `resolvedSkills` to each `RunAgentEffect`.

Key rules:

- `loadAvailableSkills()` is adapter-owned — the engine never scans skill directories itself.
- `resolveSkillsForAgent()` and `resolveSkillsForConfig()` are pure engine helpers — they accept explicit `availableSkills` input and return `Result<ResolvedSkill[], SkillResolutionError[]>`.
- `RunAgentEffect.resolvedSkills` carries only engine-resolved skill references; adapter-owned metadata (paths, content, tokens) must not appear in emitted effects.
- The deprecated `loadSkill()` method on `HarnessAdapter` is superseded by `loadAvailableSkills()` and will be removed in a future spec.

See [Spec 09 — Adapter-Provided Skill Resolution](specs/09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md) for the full vocabulary, resolution semantics, and proof artifacts.

---

## Stable Adapter Descriptor Contract

`AgentDescriptor` is the stable adapter-facing materialization contract for agent descriptors. The engine owns descriptor construction from normalized Weave config: internal `name`, optional `displayName`, composed prompt, ordered model intent, abstract raw/effective tool policy, trigger/delegation metadata, raw requested skill names, and generated category metadata.

Adapters own all concrete materialization derived from that descriptor: harness resource ids, generated files, plugin entries, concrete model availability checks, selected-model lookup, concrete model-field formatting, concrete tool-name mapping, permissions enforcement, harness resource generation, and feature-gap emulation.

Key rules:

- `descriptor.name` is the stable harness-neutral internal id; adapters use it for durable resource identity and must not rewrite it from labels.
- `descriptor.displayName` is optional presentation metadata composed from Weave-owned config such as agent `display_name`; adapters may show it when supported, but it is not stable identity and must not replace `descriptor.name`.
- `descriptor.composedPrompt` is the final prompt; raw `prompt`, `prompt_file`, and `prompt_append` are not adapter inputs.
- `descriptor.models` is ordered model intent, not proof of model availability, not selected-model state, and not a harness-formatted model field.
- `descriptor.rawToolPolicy` and `descriptor.effectiveToolPolicy` are abstract policy fields; adapters map them to concrete harness permissions.
- `descriptor.category` is present only for generated category shuttles and carries category name, optional description, and patterns.
- Disabled agents and suppressed category shuttles are omitted from materialization rather than emitted as disabled descriptors.
- Workflow and command materialization are outside the `AgentDescriptor` contract.

See [Spec 14 — Stable Adapter Descriptor Contract](specs/14-spec-stable-adapter-descriptor-contract/14-spec-stable-adapter-descriptor-contract.md) for the normative field table, examples, disabled-entry rules, and proof artifacts.

---

## Transitional Interfaces

Some current code still uses early placeholder methods such as `loadSkill()` or `registerHook()` on `HarnessAdapter`. Treat these as **transitional implementation details**, not product architecture precedent.

- `loadSkill()` is deprecated and superseded by `loadAvailableSkills()` (see Spec 09 above). Adapters should provide the full available-skill list upfront; the engine resolves references against it.
- `registerHook()` will be replaced or reframed around adapter-owned lifecycle event mapping into engine policy surfaces.

Future specs should move toward this boundary:

- adapters provide harness-owned context to engine helpers (`availableSkills`, `availableModels`, lifecycle events)
- engine returns normalized descriptors, resolved skills, composed prompts, policy decisions, or abstract effects
- adapters materialize those outputs in the concrete harness

When a legacy issue or proof artifact conflicts with this document, prefer this document and [Product Vision](product-vision.md).

---

## Adapter Capability Contract

The **Adapter Capability Contract** (Spec 07) extends this boundary with a
structured readiness vocabulary. Adapters declare which Weave behaviors they
support (`native`, `emulated`, `degraded`, `unsupported`) and supply runtime
probe results. The engine evaluates those declarations against the Core
Readiness Profile without performing harness I/O.

**Ownership rules for capability declarations:**

| Concern                                         | Owner   | Why                                                          |
| ----------------------------------------------- | ------- | ------------------------------------------------------------ |
| Static capability declarations                  | Adapter | Adapters know what their harness supports                    |
| Runtime probe results (file/env/version checks) | Adapter | Harness-specific checks belong in adapters                   |
| Core Readiness Profile evaluation               | Engine  | Pure function; accepts explicit adapter-supplied inputs      |
| Health report construction                      | Engine  | `buildAdapterHealthReport` is pure; no harness I/O           |
| Renderer-ready row structures                   | Engine  | `buildHumanRows`, `buildToonRows`, `toJson` are pure helpers |
| Terminal presentation (CLI output)              | CLI     | Concrete display is a CLI concern                            |

**Safe Adapter Init** is the read-only path where an adapter gathers
`SafeAdapterInitInput` (static declarations + probe results) before passing it
to `buildAdapterHealthReport`. Safe Adapter Init:

- MUST NOT materialize agents.
- MUST NOT register lifecycle hooks.
- MUST NOT launch workflows or workflow steps.
- MUST NOT mutate harness configuration or state.
- MUST NOT write generated config files.
- MUST NOT start harness runtimes or processes.
- MAY perform read-only harness environment checks (file existence, env vars,
  version queries) and report results as `CapabilityProbeResult` entries.

See [Spec 07 — Adapter Capability Contract](specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md)
for the full vocabulary, readiness gate semantics, and proof artifacts.

---

## Abstract Tool Policy Evaluation

The engine evaluates abstract `tool_policy` declarations into a fully-resolved
`EffectiveToolPolicy` before passing the composed `AgentDescriptor` to adapters.
Adapters receive the **raw** `tool_policy` unchanged as `descriptor.rawToolPolicy`
via `spawnSubagent(descriptor: AgentDescriptor)`; the engine-computed effective
policy is surfaced both on the descriptor (`descriptor.effectiveToolPolicy`) and
via the `onEffect` callback on `WeaveRunnerOptions`.

Key rules:

- The engine owns `evaluateEffectiveToolPolicy` — a pure, deterministic helper
  that fills missing capabilities with `DEFAULT_PERMISSION` (`"ask"`).
- Adapters own the mapping from abstract capabilities (`read`, `write`,
  `execute`, `delegate`, `network`) to concrete harness tool names.
- No harness-specific tool identifiers appear in engine code or emitted effects.
- Category shuttle agents (`shuttle-{category}`) have their category's
  `tool_policy` evaluated and emitted the same way as regular agents.

See [Tool Policy Evaluation](tool-policy-evaluation.md) for the full vocabulary,
`EffectiveToolPolicy`, `DEFAULT_PERMISSION`, `evaluateEffectiveToolPolicy`,
`RunAgentEffect`, and the adapter contract. See
[Spec 08 — Abstract Tool Policy Evaluation](specs/08-spec-abstract-tool-policy-evaluation/08-spec-abstract-tool-policy-evaluation.md)
for the formal spec and proof artifacts.

---

## Execution Lifecycle Surface

> **Issue:** [#44 — Minimal Execution Lifecycle Surface](https://github.com/josevalim/weave/issues/44) · **Spec:** [Spec 13 — Minimal Execution Lifecycle Surface](specs/13-spec-minimal-execution-lifecycle-surface/13-spec-minimal-execution-lifecycle-surface.md)

The **Execution Lifecycle Surface** is the engine-owned abstract API that adapters call after mapping concrete harness events into normalized lifecycle inputs. It supersedes the transitional `registerHook()` method on `HarnessAdapter`.

All types are exported from `@weave/engine` under `packages/engine/src/execution-lifecycle.ts`.

### The 7 Lifecycle Methods

| Method | Adapter calls this when… | Engine responsibility |
| --- | --- | --- |
| `observeSession` | A harness session observation is available | Record a `SessionSnapshot` in the Runtime Store |
| `startExecution` | A new workflow execution begins | Acquire an execution lease; transition instance to `running` |
| `resumeExecution` | A paused or blocked execution resumes | Acquire a new lease (replacing expired); transition to `running` |
| `handleUserInterrupt` | The user explicitly cancels or pauses | Evaluate interrupt policy; return pause/complete effects |
| `dispatchStep` | The next workflow step should be dispatched | Resolve step agent and policy; return a `DispatchAgentEffect` |
| `completeStep` | A workflow step has finished | Record completion; determine next effects (dispatch/pause/complete) |
| `beforeTool` | A tool call is about to execute | Evaluate abstract tool policy; return `allow`/`deny`/`ask` decision |

**Adapter responsibility**: map concrete harness events (session events, user signals, tool invocations) into these abstract inputs. The engine does not know about harness-specific event names, payloads, or callback registration.

**Engine responsibility**: evaluate policy, update Runtime Store state, and return typed `LifecycleEffect` values. The engine does not register harness callbacks or inspect harness-specific state.

### `beforeTool` — Adapter/Engine Boundary

`beforeTool` is the lifecycle point called immediately before a tool executes. The boundary is strict:

**Adapters own concrete tool-name mapping:**
- The adapter knows which harness tools exist and what abstract capability each maps to.
- The adapter maps the concrete harness tool name (e.g. `"edit_file"`, `"bash"`, `"read_file"`) to an abstract capability (`"read"`, `"write"`, `"execute"`, `"delegate"`, `"network"`) and passes it as `toolCapability` in `BeforeToolInput`.
- The engine never inspects, hard-codes, or branches on `toolName` for policy decisions.

**The engine owns abstract policy decisions:**
- The engine reads `effectiveToolPolicy[toolCapability]` from the adapter-supplied `EffectiveToolPolicy` and returns the corresponding `allow` / `deny` / `ask` decision.
- The engine does not re-derive or re-evaluate the policy — it trusts the adapter-supplied `effectiveToolPolicy`.
- `toolName` in `BeforeToolInput` is for audit/logging only — it is opaque to the engine.

```ts
// ✅ Correct: adapter maps concrete tool → abstract capability; engine reads policy
const result = await beforeTool({
  workflowInstanceId: event.workflowInstanceId,
  leaseId: event.leaseId,
  agentName: event.agentName,
  toolCapability: adapterToolMap.get(event.toolName) ?? "execute", // adapter-owned mapping
  toolName: event.toolName,                                         // audit only
  effectiveToolPolicy: agentDescriptor.effectiveToolPolicy,         // adapter-supplied
});

// ❌ Wrong: engine inspects concrete tool name for policy
if (input.toolName === "bash") { /* harness-specific logic */ }
```

**Security invariants for `beforeTool`:**
- `BeforeToolInput` structurally excludes credentials, tokens, raw tool arguments, and harness-private state. Only `workflowInstanceId`, `leaseId`, `agentName`, `toolCapability`, `toolName` (audit), `effectiveToolPolicy`, and optional `SafeMetadata` are accepted.
- `BeforeToolOutput` contains only `decision` (`"allow"` | `"deny"` | `"ask"`) and an optional `reason` string. No raw payloads, credentials, or harness state appear in the output.
- `beforeTool` does NOT access the Runtime Store — it is a pure policy evaluation wrapped in `ResultAsync` for interface consistency.

### `registerHook()` is Superseded

The `registerHook()` method on `HarnessAdapter` is deprecated and will be removed in a future spec. Adapters should map harness events into the lifecycle surface instead:

```ts
// ❌ Old: engine registers a concrete harness hook
await adapter.registerHook({ name: "on-session-idle", enabled: true, event: "session.idle" });

// ✅ New: adapter maps harness event → lifecycle surface
harnessRuntime.on("session.idle", async (event) => {
  const result = await lifecycleSurface.observeSession({
    workflowInstanceId: event.workflowInstanceId,
    leaseId: event.leaseId,
    harnessName: "opencode",
    agentName: event.agentName,
    sessionStatus: "idle",
  });
  // handle result...
});
```

### `LifecycleEffect` Union

`dispatchStep` and `completeStep` return `LifecycleEffect[]`. The dispatch variant wraps `RunAgentEffect`:

```ts
type LifecycleEffect =
  | { kind: "dispatch-agent"; runAgent: RunAgentEffect }  // wraps RunAgentEffect
  | { kind: "pause-execution"; workflowInstanceId: WorkflowInstanceId; reason?: string }
  | { kind: "complete-execution"; workflowInstanceId: WorkflowInstanceId };
```

Adapters receive these effects and apply harness-specific materialisation (e.g. spawning an agent, pausing a session, updating UI state).

### `LifecycleError` Discriminated Union

All lifecycle methods return `ResultAsync<T, LifecycleError>` from neverthrow — errors are never thrown.

| Discriminant | Meaning |
| --- | --- |
| `validation` | Invalid lifecycle input (missing field, denied metadata key) |
| `not_found` | Referenced workflow instance, step, or session not found |
| `lease_conflict` | Unexpired foreign lease blocks the operation |
| `persistence` | Underlying Runtime Store write failed |
| `policy_decision` | Policy evaluation failed |

### `SafeMetadata` Constraint

All lifecycle input types accept an optional `metadata?: SafeMetadata` field. `SafeMetadata` is typed as `Record<string, string | number | boolean>` — structurally preventing nested objects, arrays, raw prompts, and credential payloads. The runtime sanitizer additionally rejects known credential field names (e.g. `token`, `apiKey`, `password`).

### Runtime Store Relationship

The lifecycle surface is the engine-owned write path into the Runtime Store for session observations and step completions. Adapters do not write to the Runtime Store directly — they call lifecycle methods and the engine handles persistence.

```text
Adapter (harness event) → lifecycle method → engine policy → Runtime Store write → LifecycleEffect[]
                                                                                         ↓
                                                                              Adapter materialises effects
```

See [`packages/engine/src/execution-lifecycle.ts`](../packages/engine/src/execution-lifecycle.ts) for the full type definitions and factory helpers.

---

## Workflow Engine

> **Spec:** [Spec 10 — Workflow Engine](specs/10-spec-workflow-engine/10-spec-workflow-engine.md)

The workflow engine is the engine-owned subsystem that drives multi-step workflow execution. It is implemented inside the Execution Lifecycle Surface (`execution-lifecycle.ts`) and operates exclusively through the 7 lifecycle methods described above.

### Ownership Matrix — Workflow Engine

| Concern | Owner | Why |
| --- | --- | --- |
| Workflow topology (step order, step count, final-step detection) | Engine | Derived from `WorkflowConfig.steps` — a Weave-owned data structure |
| Artifact resolution (validating declared `inputs`/`outputs`, persisting artifacts) | Engine | Artifact state is Weave runtime state stored in the Runtime Store |
| Completion method evaluation (`agent_signal`, `user_confirm`, `review_verdict`, `plan_created`, `plan_complete`) | Engine | Completion semantics are defined by the Weave DSL schema |
| Gate decisions (approve/reject, `on_reject` policy: `pause`/`fail`/`retry`) | Engine | Policy evaluation is harness-neutral; the engine reads `on_reject` from `WorkflowStep` |
| Abstract lifecycle effects (`dispatch-agent`, `pause-execution`, `complete-execution`) | Engine | Effects are pure data records; the engine emits them, adapters apply them |
| Harness event detection and mapping into lifecycle inputs | Adapter | Event names, payloads, and callback registration are harness-specific |
| Materializing lifecycle effects in the concrete harness | Adapter | Spawning agents, pausing sessions, updating UI state are harness-specific |

### Engine Responsibilities in Detail

**Workflow topology**: The engine reads `WorkflowConfig.steps` (an ordered array) to determine step sequence. `startExecution` sets `currentStepName` to `steps[0].name`. `completeStep` advances to the next step by index, or transitions to `completed` when the final step finishes.

**Artifact resolution**: `dispatchStep` validates that all artifacts declared in `step.inputs` are present in the instance's artifact store before emitting the dispatch effect. `completeStep` validates that all artifacts declared in `step.outputs` are present in the completion signal before persisting them via `store.instances.addArtifact()`. Validation is all-or-nothing — a missing artifact returns a `validation` error before any state changes.

**Completion method evaluation**: The engine validates the `completionSignal.method` in `CompleteStepInput` against the step's declared `completion.method`. Each method has defined semantics:
- `agent_signal` / `user_confirm` — treat as success; auto-advance
- `review_verdict` — `approved: true` → advance; `approved: false` → apply `on_reject` policy
- `plan_created` / `plan_complete` — check plan file state (`.weave/plans/<plan_name>.md`)

**Gate decisions**: When a `review_verdict` signal arrives with `approved: false`, the engine reads `step.on_reject`:
- `pause` → transitions instance to `paused`, emits `pause-execution` (lease remains held)
- `fail` → transitions instance to `failed`, releases lease, emits `complete-execution`
- `retry` → re-dispatches the same step with a fresh `correlationId`

**Abstract effects**: The engine emits `LifecycleEffect[]` — pure data records. Adapters receive these and apply harness-specific materialisation. The engine never spawns agents, pauses harness sessions, or updates harness UI state directly.

### Adapter Responsibilities

Adapters own:
- Detecting harness events (step completion signals, user interrupts, tool calls) and mapping them to lifecycle inputs
- Providing `WorkflowExecutionContext` (with `workflowName`, `goal`, `slug`, and the `workflows` map) to lifecycle methods that require it
- Applying returned `LifecycleEffect` values: spawning agents for `dispatch-agent`, pausing sessions for `pause-execution`, cleaning up for `complete-execution`

### Anti-Patterns

```ts
// ❌ Wrong: engine inspects harness-specific step completion event format
if (harnessEvent.type === "opencode:step:done") { ... }

// ❌ Wrong: engine spawns an agent directly
await harnessRuntime.spawnAgent(stepConfig.agent, prompt);

// ✅ Correct: adapter maps harness event → lifecycle input; engine returns effects
const result = await completeStep({ workflowInstanceId, leaseId, stepName, completionSignal }, store);
result.match(
  ({ effects }) => adapter.applyEffects(effects),
  (err) => log.error({ err }, "completeStep failed"),
);
```
