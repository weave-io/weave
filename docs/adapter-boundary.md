# Adapter Boundary

Weave is a harness-agnostic orchestration framework with two cooperating halves:

1. **Core Weave API** (`@weave/core`, `@weave/config`, `@weave/engine`) parses DSL config, normalizes agent intent, resolves/composes prompt and policy data, and exposes pure helper APIs.
2. **Adapters** (`@weave/adapter-opencode`, `@weave/adapter-pi`, etc.) enable Weave inside a concrete harness by discovering harness-owned resources, translating normalized intent, and filling feature gaps when the harness lacks native support.

**Related:** [Product Vision](product-vision.md) · [Model Resolution](model-resolution.md) · [Config Loading](config-loading.md) · [Spec 05 — Skill Resolution](specs/05-spec-skill-loader/05-spec-skill-loader.md) · [Legacy Architecture](legacy-architecture.md)

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

## Transitional Interfaces

Some current code still uses early placeholder methods such as `loadSkill()` or `registerHook()` on `HarnessAdapter`. Treat these as **transitional implementation details**, not product architecture precedent.

Future specs should move toward this boundary:

- adapters provide harness-owned context to engine helpers (`availableSkills`, `availableModels`, lifecycle events)
- engine returns normalized descriptors, resolved skills, composed prompts, policy decisions, or abstract effects
- adapters materialize those outputs in the concrete harness

When a legacy issue or proof artifact conflicts with this document, prefer this document and [Product Vision](product-vision.md).
