# Adapter Boundary

Weave is a harness-agnostic orchestration framework with two cooperating halves:

1. **Core Weave API** (`@weave/core`, `@weave/config`, `@weave/engine`) parses DSL config, normalizes agent intent, resolves/composes prompt and policy data, and exposes pure helper APIs.
2. **Adapters** (`@weave/adapter-opencode`, `@weave/adapter-pi`, etc.) enable Weave inside a concrete harness by discovering harness-owned resources, translating normalized intent, and filling feature gaps when the harness lacks native support.

**Related:** [Product Vision](product-vision.md) · [Model Resolution](model-resolution.md) · [Config Loading](config-loading.md) · [Prompt Composition](prompt-composition.md) · [Tool Policy Evaluation](tool-policy-evaluation.md) · [Spec 05 — Skill Resolution](specs/05-spec-skill-loader/05-spec-skill-loader.md) · [Spec 07 — Adapter Capability Contract](specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md) · [Spec 08 — Abstract Tool Policy Evaluation](specs/08-spec-abstract-tool-policy-evaluation/08-spec-abstract-tool-policy-evaluation.md) · [Spec 09 — Adapter-Provided Skill Resolution](specs/09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md) · [Legacy Architecture](legacy-architecture.md)

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
