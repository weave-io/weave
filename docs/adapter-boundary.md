# Adapter Boundary

Weave is a harness-agnostic orchestration framework with two cooperating halves:

1. **Core Weave API** (`@weave/core`, `@weave/config`, `@weave/engine`) parses DSL config, normalizes agent intent, resolves/composes prompt and policy data, and exposes pure helper APIs.
2. **Adapters** (`@weave/adapter-opencode`, `@weave/adapter-pi`, etc.) enable Weave inside a concrete harness by discovering harness-owned resources, translating normalized intent, and filling feature gaps when the harness lacks native support.

**Related:** [Product Vision](product-vision.md) · [Adapter Bootstrap Guide](adapter-bootstrap.md) · [Claude Code Adapter](claude-code-adapter.md) · [Model Resolution](model-resolution.md) · [Config Loading](config-loading.md) · [Prompt Composition](prompt-composition.md) · [Tool Policy Evaluation](tool-policy-evaluation.md) · [Adapter Readiness Status](adapter-readiness-status.md) · [ADR 0003 — OpenCode Adapter Materialization Shape](adr/0003-opencode-adapter-materialization-shape.md) · [Runtime Persistence Spec](specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md) · [ADR 0002 — Runtime Persistence Store](adr/0002-runtime-persistence-store.md) · [Spec 09 — Adapter-Provided Skill Resolution](specs/09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md) · [Spec 07 — Adapter Capability Contract](specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md) · [Spec 08 — Abstract Tool Policy Evaluation](specs/08-spec-abstract-tool-policy-evaluation/08-spec-abstract-tool-policy-evaluation.md) · [Spec 15 — Adapter-Facing Materialization API](specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) · [Spec 16 — Stable Adapter Descriptor Contract](specs/16-spec-stable-adapter-descriptor-contract/16-spec-stable-adapter-descriptor-contract.md) · [Spec 17 — Workflow Extension DSL](specs/17-spec-workflow-extension/17-spec-workflow-extension.md) · [Spec 18 — Delegation Exclusion](specs/18-spec-delegation-exclusion/18-spec-delegation-exclusion.md) · [Spec 19 — Plan State Provider](specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md) · [Spec 20 — OpenCode Adapter Materialization](specs/20-spec-opencode-adapter-materialization/20-spec-opencode-adapter-materialization.md) · [Spec 22 — Workflow-First Execution](specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) · [ADR 0004 — Workflow-First Execution Contract](adr/0004-workflow-first-execution-contract.md) · [Execution Lifecycle Surface](#execution-lifecycle-surface) · [Legacy Architecture](legacy-architecture.md)

---

## Boundary Rule

The key question is not "does the engine call the adapter?" The key question is:

> **Is the engine making a harness-specific assumption?**

Engine-to-adapter calls are acceptable when they use abstract, harness-agnostic intent. They are incorrect when they require the engine to know where a harness stores resources, how a harness registers lifecycle callbacks, or how a harness represents runtime state.

---

## Naming Conventions

Type names in `@weave/core` and `@weave/engine` follow a suffix convention to prevent collisions between the DSL configuration layer and the engine runtime layer:

- **`*Decl` suffix** — used for core/DSL types that describe **declarative configuration** authored in `.weave` files. These types are parsed from the DSL and validated by Zod schemas. Example: `ArtifactDecl` describes a named artifact input or output declared on a workflow step.
- **`*Ref` suffix** — used for engine runtime types that describe **persisted handles** or live records in the Runtime Store. These types are created and managed at execution time. Example: `ArtifactRef` (in `@weave/engine`) is a persisted artifact record with a logical name, a relative path, and optional `mimeType`, `description`, and integrity-verification metadata — it stores a reference and metadata only, never raw artifact contents.

When adding a new type that spans both layers (e.g. a concept declared in DSL config and also tracked at runtime), use `*Decl` for the core/DSL variant and `*Ref` for the engine runtime variant. Never share a single type name across both layers.

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
| Plan file state (`.weave/plans/**`)                | Adapter                  | Concrete I/O mechanism is harness/environment-specific; engine owns the `PlanStateProvider` interface only |
| Artifact integrity metadata (`ArtifactIntegrityMetadata`) | Engine (`@weave/engine`) | Stored in `ArtifactRef` inside the Runtime Store; engine owns the type, comparison logic, and fail-closed policy |
| Artifact digest computation (reading file, hashing) | Adapter                 | Adapters read artifact files and compute SHA-256 digests before calling `dispatchStep`; the engine never reads artifact file contents |
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

### Category Metadata on Generated Shuttles

The engine preserves source category context on generated category shuttle descriptors through `AgentDescriptor.category?: CategoryMetadata`. This metadata is normalized, harness-agnostic intent for adapters that need to materialize category-aware routing or harness configuration.

`CategoryMetadata` contains:

- `name` — the source category name from `.weave` config.
- `description?` — the category description when declared.
- `patterns` — the category's declared glob strings exactly as authored; these are **not** expanded file lists.
- `isCategory: true` — an explicit marker that the descriptor was generated from a category.

Adapters MAY use `category.patterns` when generating harness-specific routing rules, plugin config, or delegation metadata. Concrete routing decisions remain adapter-owned because only adapters know the target harness' routing model and resource conventions.

The engine MUST NOT expand category globs, scan project files to match patterns, inspect harness-owned resources, or infer concrete harness routes. It only carries declared strings forward on the descriptor.

### Runtime Store

The engine owns durable Weave runtime state under `.weave/runtime/**`, including the default `.weave/runtime/weave.db` Runtime Store described in [ADR 0002](adr/0002-runtime-persistence-store.md).

This is a narrow boundary exception: the engine may perform Bun filesystem/database I/O only for Weave-owned runtime records. It must not inspect harness-owned storage, harness session internals, harness model registries, or concrete harness plugin state. Adapters may emit sanitized observations through an engine-provided Runtime Journal writer, but adapters do not receive direct database ownership.

### Artifact Integrity Metadata

> **Spec:** [Spec 22 — Workflow-First Execution](specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) (Unit 3)

**`ArtifactIntegrityMetadata`** is the engine-owned type that stores a salted SHA-256 digest for tamper detection on a persisted artifact revision. It lives inside `ArtifactRef` in the Runtime Store — never in adapter-owned storage, harness session state, or raw artifact file contents.

**What it contains:**

| Field | Type | Meaning |
| --- | --- | --- |
| `algorithm` | `"sha256"` | Hash algorithm; only `"sha256"` is accepted |
| `digest` | `string` | Lowercase hex-encoded SHA-256 digest (64 characters) |

**What it explicitly excludes:**

- Raw artifact file contents
- Raw prompts or completions used to produce the artifact
- Private filesystem paths outside the project root
- Credentials, tokens, cookies, or authorization headers

**Boundary rules:**

- The engine owns `ArtifactIntegrityMetadata` type definition, digest format validation (64 lowercase hex chars), and the fail-closed comparison in `dispatchStep`.
- Adapters own artifact file I/O: reading the artifact file and computing the SHA-256 digest before calling `dispatchStep`. The engine never reads artifact file contents.
- Adapters pass the computed digest via `DispatchStepInput.artifactDigests` — a `Record<string, string>` map of artifact name → current digest.
- The engine compares the supplied digest against the stored `ArtifactRef.integrity.digest`. A mismatch returns a `policy_decision` error; the engine fails closed.
- Integrity verification is **opt-in**: if `artifactDigests` is omitted or does not include a key for a given artifact, no check is performed for that artifact. Artifacts without a stored `integrity` field are never checked even if a digest is supplied.
- Digest computation uses SHA-256 only. MD5, SHA-1, and non-cryptographic hashes are forbidden by construction.

**Correct data flow:**

```ts
// ✅ Correct: adapter reads file and computes digest; engine compares against stored metadata
const fileContent = await Bun.file(artifactPath).text();
const digest = await computeSha256Hex(fileContent); // adapter-owned
const result = await dispatchStep(
  {
    workflowInstanceId,
    leaseId,
    stepName,
    context,
    artifactDigests: { plan_path: digest }, // adapter supplies; engine compares
  },
  store,
);

// ❌ Wrong: engine reads artifact file contents directly
const content = await Bun.file(artifact.path).text(); // boundary violation
```

**Relationship to `ArtifactRef`:**

`ArtifactRef` is the persisted artifact record in the Runtime Store. Its optional `integrity` field holds `ArtifactIntegrityMetadata`. A new artifact revision always resets `approvalState` to `pending` and may carry updated integrity metadata. The engine stores integrity metadata only — never the artifact content itself.

See [`packages/engine/src/runtime/types.ts`](../packages/engine/src/runtime/types.ts) for the `ArtifactIntegrityMetadata` and `ArtifactRef` type definitions. See [`packages/engine/src/execution-lifecycle.ts`](../packages/engine/src/execution-lifecycle.ts) for the `DispatchStepInput.artifactDigests` field and the fail-closed comparison logic.

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

**Transitional adapter surface decision (Spec 09):** The `HarnessAdapter` interface exposes `loadAvailableSkills(): Promise<SkillInfo[]>`. This method is called once during the adapter bootstrap sequence (after `init()` and before agent materialization). Adapters return a flat list of `SkillInfo` descriptors; the engine resolves requested skill names against that list via `resolveSkillsForConfig()`.

Key rules:

- `loadAvailableSkills()` is adapter-owned — the engine never scans skill directories itself.
- `resolveSkillsForAgent()` and `resolveSkillsForConfig()` are pure engine helpers — they accept explicit `availableSkills` input and return `Result<ResolvedSkill[], SkillResolutionError[]>`.
- `RunAgentEffect.resolvedSkills` carries only engine-resolved skill references; adapter-owned metadata (paths, content, tokens) must not appear in emitted effects.
- Earlier drafts used a placeholder `loadSkill()` method on `HarnessAdapter`. That method has been removed from the interface; adapters should implement `loadAvailableSkills()` only.

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

### Stable descriptor field table

| Field | Owner | Stable meaning | Adapter responsibility |
| --- | --- | --- | --- |
| `name` | Engine | Stable harness-neutral internal id. | Use for durable resource identity; map to harness ids without changing Weave identity. |
| `displayName` | Engine | Optional presentation metadata from Weave config. | Render when supported; apply harness-specific label formatting if needed. |
| `description` | Engine | Optional user-authored description. | Surface as harness description/help text where supported. |
| `composedPrompt` | Engine | Final rendered prompt after prompt source loading, delegation fallback, and `prompt_append`. | Materialize directly; do not re-read raw prompt sources. |
| `models` | Engine | Ordered model intent from config/category declarations. | Check availability, selected model state, fallback choice, and concrete model-field formatting. |
| `mode` | Engine | Harness-neutral context hint: `primary`, `subagent`, or `all`. | Translate into concrete harness agent roles or document unsupported behavior. |
| `temperature` | Engine | Optional numeric generation preference. | Format or omit according to harness model settings. |
| `rawToolPolicy` | Engine | Original abstract `tool_policy`, when declared. | Map abstract capabilities to concrete tool names and permission settings. |
| `effectiveToolPolicy` | Engine | Abstract policy with every capability resolved. | Enforce through concrete harness permissions. |
| `delegationTargets` | Engine | Harness-neutral eligible delegation targets and triggers. | Generate routing affordances, subagent references, commands, or unsupported notices. |
| `skills` | Engine | Requested skill names only. | Resolve/load skill payloads through adapter-owned discovery; never expect paths/contents here. |
| `category` | Engine | Optional generated-shuttle metadata: category name, optional description, declared patterns. | Apply harness routing/materialization conventions without expanding globs in the engine. |

See [Spec 16 — Stable Adapter Descriptor Contract](specs/16-spec-stable-adapter-descriptor-contract/16-spec-stable-adapter-descriptor-contract.md) for the normative field table, examples, disabled-entry rules, and proof artifacts.

---

## Transitional Interfaces

Earlier drafts and proof artifacts referenced placeholder methods such as `loadSkill()` and `registerHook()` on `HarnessAdapter`. Those methods are **not part of the current interface**. Treat them as historical migration context only, not architecture precedent.

- `loadSkill()` was replaced by `loadAvailableSkills()` (see Spec 09 above). Adapters provide the full available-skill list upfront; the engine resolves references against it.
- `registerHook()` was replaced by the Execution Lifecycle Surface (Spec 13). Adapters map harness events into the 7 typed lifecycle functions instead of exposing hook registration through the engine boundary.

Future specs should move toward this boundary:

- adapters provide harness-owned context to engine helpers (`availableSkills`, `availableModels`, lifecycle events)
- engine returns normalized descriptors, resolved skills, composed prompts, policy decisions, or abstract effects
- adapters materialize those outputs in the concrete harness

When a legacy issue or proof artifact conflicts with this document, prefer this document and [Product Vision](product-vision.md).

See [Adapter Bootstrap Guide](adapter-bootstrap.md) for the canonical `loadConfig` → `materializeAgents` → adapter loop pattern with a runnable `MockAdapter` example.

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
via the `onEffect` callback on `MaterializationInput` (see [Adapter Bootstrap Guide](adapter-bootstrap.md)).

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

> **Issue:** [#44 — Minimal Execution Lifecycle Surface](https://github.com/josevalim/weave/issues/44) · **Spec:** [Spec 13 — Minimal Execution Lifecycle Surface](specs/13-spec-minimal-execution-lifecycle-surface/13-spec-minimal-execution-lifecycle-surface.md) · **Spec:** [Spec 22 — Workflow-First Execution](specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) · **ADR:** [ADR 0004 — Workflow-First Execution Contract](adr/0004-workflow-first-execution-contract.md)

The **Execution Lifecycle Surface** is the engine-owned abstract API that adapters call after mapping concrete harness events into normalized lifecycle inputs. It supersedes earlier placeholder `registerHook()` designs.

All types are exported from `@weave/engine` under `packages/engine/src/execution-lifecycle.ts`.

### The 8 Lifecycle Methods

| Method | Adapter calls this when… | Engine responsibility |
| --- | --- | --- |
| `observeSession` | A harness session observation is available | Record a `SessionSnapshot` in the Runtime Store |
| `startExecution` | A new workflow execution begins | Acquire an execution lease; transition instance to `running` |
| `resumeExecution` | A paused or blocked execution resumes | Acquire a new lease (replacing expired); transition to `running` |
| `handleUserInterrupt` | The user explicitly cancels or pauses | Evaluate interrupt policy; return pause/complete effects |
| `dispatchStep` | The next workflow step should be dispatched | Resolve step agent and policy; return a `DispatchAgentEffect` |
| `completeStep` | A workflow step has finished | Record completion; determine next effects (dispatch/pause/complete) |
| `beforeTool` | A tool call is about to execute | Evaluate abstract tool policy; return `allow`/`deny`/`ask` decision |
| `inspectExecution` | Adapter needs to query execution state without side effects | Return a read-only snapshot of the `WorkflowInstance` and lease status |

**Adapter responsibility**: map concrete harness events (session events, user signals, tool invocations) into these abstract inputs. The engine does not know about harness-specific event names, payloads, or callback registration.

**Engine responsibility**: evaluate policy, update Runtime Store state, and return typed `LifecycleEffect` values. The engine does not register harness callbacks or inspect harness-specific state.

### Execution Operations vs. Observations

The lifecycle surface distinguishes two categories of operations:

**Explicit execution operations** (`ExecutionOperationKind`): `start`, `resume`, `pause`, `inspect`, `advance`. These map to `startExecution`, `resumeExecution`, `handleUserInterrupt` (pause signal), `inspectExecution`, and `dispatchStep`/`completeStep` respectively. Only `startExecution` may create a `WorkflowInstance` or acquire an `ExecutionLease`.

**Observation operations**: `observeSession` and `beforeTool`. These are passive — they never create instances, acquire leases, or emit `LifecycleEffect` values. Adapters may call `observeSession` from idle hooks, continuation hooks, or session events without risking implicit execution start.

**Execution boundary invariant** (ADR 0004): `startExecution` is the sole authorized entry point for durable execution. Ordinary Loom conversation, session idle events, continuation hooks, and lifecycle observations are explicitly forbidden from implicitly starting durable execution. Adapters must call `startExecution` only in response to an explicit, user-authorized trigger.

**Adapter delivery of the execution contract** (Spec 22 Unit 4): Commands, hooks, skills, scripts, and UI affordances are all **adapter-owned projections of the same engine-owned execution contract**. The engine defines what execution means — `startExecution` is the sole authorized entry point, and the engine owns all state transitions, lease management, and effect emission. Adapters own the concrete delivery mechanism that exposes the explicit user-authorized trigger in their harness. The engine does not dictate which delivery form an adapter uses; it only requires that `startExecution` is called after an explicit user action. Adapters declare their delivery capability through the `command-entrypoints` readiness value in their `AdapterCapabilityContract`:

- `native` — literal harness commands (e.g. `/run-workflow`)
- `emulated` — equivalent explicit delivery via skill, script, or UI (satisfies the Core Readiness Profile)
- `degraded` — incomplete or inconsistent explicit delivery
- `unsupported` — no reliable explicit start path

`workflow-step-dispatch` is **supporting execution context** — it models step dispatch within a running execution, not execution entry. It is not a substitute for `command-entrypoints` readiness. See [Adapter Readiness Status](adapter-readiness-status.md#execution-command-readiness-spec-22-unit-4) for the full readiness vocabulary and declaration examples.

**OpenCode adapter evidence** (task 6.3): `packages/adapters/opencode/src/run-workflow.ts` is the OpenCode adapter's explicit user-driven helper — the adapter-owned projection of the engine's `startExecution` lifecycle method. Tests in `packages/adapters/opencode/src/__tests__/run-workflow.test.ts` prove that execution enters only through explicit `runWorkflow` calls, that idle hooks and session events do not start durable execution, and that `PlanStateProvider` is supplied at plan-oriented completion boundaries. See [Adapter Readiness Status](adapter-readiness-status.md#opencode-adapter-delivery-evidence-task-63) for the full evidence summary.

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

### Earlier `registerHook()` Designs Are Superseded

Earlier drafts referenced a `registerHook()` method on `HarnessAdapter`. That method is not part of the current interface. Adapters should map harness events into the lifecycle surface instead:

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

> **Spec:** [Spec 10 — Workflow Engine](specs/10-spec-workflow-engine/10-spec-workflow-engine.md) · **Spec:** [Spec 22 — Workflow-First Execution](specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) · **ADR:** [ADR 0004 — Workflow-First Execution Contract](adr/0004-workflow-first-execution-contract.md)

The workflow engine is the engine-owned subsystem that drives multi-step workflow execution. It is implemented inside the Execution Lifecycle Surface (`execution-lifecycle.ts`) and operates exclusively through the 8 lifecycle methods described above.

**Execution boundary**: `startExecution` is the sole authorized entry point for durable execution. Ordinary Loom conversation, session idle events, continuation hooks, and lifecycle observations (`observeSession`) are explicitly forbidden from implicitly starting durable execution. Commands, hooks, skills, scripts, and UI affordances are all adapter-owned projections of the same engine-owned execution contract — adapters choose the delivery form; the engine owns the semantics. Adapters call `startExecution` only after an explicit user-authorized trigger. See [ADR 0004](adr/0004-workflow-first-execution-contract.md) for the full rationale and ownership matrix.

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

---

## Agent Materialization API

> **Spec:** [Spec 15 — Adapter-Facing Materialization API](specs/15-spec-adapter-facing-materialization-api/)

`materializeAgents(input)` is the engine-owned pure API for composing all adapter-facing agent descriptors from a resolved Weave config. It gives adapters one deterministic plan to translate into harness-specific plugin/config/runtime state without requiring the engine to know how any harness materializes agents.

```text
WeaveConfig → materializeAgents → MaterializationPlan → Adapter translates → Harness
```

### Data Contract

- Input: `MaterializationInput { config: WeaveConfig }`. No `HarnessAdapter` is required; the engine receives only Weave-owned configuration.
- Output: `MaterializationPlan { agents: MaterializedAgent[] }`, where each `MaterializedAgent` pairs `agentName` with an engine-composed `AgentDescriptor`.
- Output order is deterministic: declared agents preserve resolved config order, followed by generated category shuttle agents in category declaration order, after disabled-agent filtering.
- Failures are typed as `MaterializationError` values (`CategoryShuttleConflict` or `DescriptorCompositionFailure`) rather than harness-specific exceptions.

### Engine Responsibilities

The engine owns:

- Descriptor composition through `composeAgentDescriptor`.
- Category shuttle generation through `generateCategoryShuttles`.
- Disabled-agent filtering before descriptors are returned.
- Ordered `MaterializationPlan` construction.
- Harness-neutral error vocabulary for materialization failures.

### Adapter Responsibilities

Adapters own everything after descriptors are returned:

- Translating `MaterializedAgent.descriptor` into concrete harness plugin configuration, generated files, process state, or runtime registrations.
- Spawning or emulating agents in the harness.
- Mapping abstract descriptor fields (models, prompts, tool policy, skills, mode) onto harness-specific capabilities and fallback behavior.
- Applying harness-specific materialization side effects and reporting any harness-specific failures outside the pure engine API.

The engine must not write harness config files, spawn harness agents, discover harness resource locations, or register concrete harness callbacks as part of `materializeAgents()`.

---

## Plan State Provider

> **Spec:** [Spec 19 — Plan State Provider](specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md)

The **Plan State Provider** is the engine-owned abstract interface that `completeStep` uses to query plan file state when a workflow step's completion method is `"plan_created"` or `"plan_complete"`. It replaces the previous direct `Bun.file()` calls inside `execution-lifecycle.ts`, which were a boundary violation.

All types are exported from `@weave/engine` under `packages/engine/src/plan-state-provider.ts`.

### Interface

```ts
interface PlanStateProvider {
  planExists(planName: string): ResultAsync<boolean, PlanStateError>;
  isPlanComplete(planName: string): ResultAsync<boolean, PlanStateError>;
}

type PlanStateError =
  | { type: "InvalidPlanName"; planName: string; reason: string }
  | { type: "ProviderUnavailable"; reason: string };
```

### Ownership Rules

| Concern | Owner | Why |
| --- | --- | --- |
| `PlanStateProvider` interface and `PlanStateError` union | Engine (`@weave/engine`) | The engine defines the abstract contract; adapters implement it |
| `validatePlanName` (safe-name regex) | Engine (`@weave/engine`) | Path traversal prevention must run before any provider call, regardless of implementation |
| `BunFilesystemPlanStateProvider` (default implementation) | Config (`@weave/config`) | Concrete Bun filesystem I/O belongs outside the engine; `@weave/config` already owns filesystem I/O for config and prompt files |
| Alternative provider implementations (database, remote, test double) | Adapter / test | Concrete I/O mechanism is harness/environment-specific |

### Engine Behaviour

- When `step.completion.method` is `"plan_created"` or `"plan_complete"` and `CompleteStepInput.planStateProvider` is **absent**, `completeStep` returns `err(lifecyclePolicyDecisionError("plan completion method requires a planStateProvider", "plan_state_provider"))` — never silently passes.
- When the provider is present, the engine calls `planStateProvider.planExists(planName)` or `planStateProvider.isPlanComplete(planName)` and maps the result to the appropriate `LifecycleError` variant.
- `validatePlanName` runs in the engine before any provider call as a path traversal defence.

### Adapter Responsibility

Adapters supply a `PlanStateProvider` implementation via `CompleteStepInput.planStateProvider`. For production use, adapters should use `BunFilesystemPlanStateProvider` from `@weave/config`. For tests, adapters should use an in-memory mock that returns controlled results without filesystem I/O.

```ts
// ✅ Correct: adapter supplies provider; engine calls interface
const result = await completeStep(
  {
    workflowInstanceId,
    leaseId,
    stepName,
    completionSignal,
    context,
    planStateProvider: new BunFilesystemPlanStateProvider(), // from @weave/config
  },
  store,
);

// ❌ Wrong: engine calls Bun.file() directly for plan files
const exists = await Bun.file(`.weave/plans/${planName}.md`).exists();
```

See [Spec 19 — Plan State Provider](specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md) for the full interface definition, error mapping, migration notes, and proof artifacts.
