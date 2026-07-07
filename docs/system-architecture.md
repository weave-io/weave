# System Architecture

This diagram is intentionally high level. It describes the conceptual flow of Weave without relying on specific source files or implementation details.

**Related:** [Product Vision](product-vision.md) · [Adapter Boundary](adapter-boundary.md) · [Config Loading](config-loading.md) · [Model Resolution](model-resolution.md) · [Harness Agent Surface Patterns](harness-agent-surface-patterns.md) · [Runtime Persistence Spec](specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md)

---

## One-Sentence Mental Model

Weave turns a declarative `.weave` configuration into normalized agent intent, lets the engine compose that intent into a harness-agnostic system plan, and lets adapters translate that plan into concrete behavior inside a target harness.

---

## System Diagram

```mermaid
flowchart TD
  User[User or Project<br/>outside Weave]

  subgraph ConfigPackages["@weaveio/weave-config + @weaveio/weave-core"]
    ConfigSources[Configuration Sources<br/>built-ins + global + project]
    ConfigLayer[Load + Normalize Config<br/>discover, parse, validate,<br/>resolve prompts, merge]
    NormalizedConfig[Normalized Weave Config<br/>single source of declared intent]
    ConfigSources --> ConfigLayer --> NormalizedConfig
  end

  subgraph EnginePackage["@weaveio/weave-engine"]
    Engine[Compose System Plan<br/>agents, prompts, categories,<br/>workflows, policies,<br/>model and skill intent]
  end

  subgraph AdapterPackage["@weaveio/weave-adapter-*"]
    HarnessContext[Harness-Owned Context<br/>available models, selected model,<br/>available skills, lifecycle events]
    Adapter[Adapter Translator<br/>target-specific materialization]
    HarnessArtifacts[Harness Artifacts<br/>plugins, config, commands,<br/>tools, permissions, runtime wiring]
    HarnessContext --> Adapter --> HarnessArtifacts
  end

  subgraph HarnessLayer["Harness Runtime"]
    Harness[Harness Runtime<br/>OpenCode, Pi, Claude Code,<br/>Codex, or future targets]
    RunningAgents[Running Agent Experience<br/>primary agents, delegated specialists,<br/>reviews, audits, workflows]
    Harness --> RunningAgents
  end

  User --> ConfigSources
  NormalizedConfig --> Engine
  Engine --> Adapter
  Adapter -. supplies explicit context .-> Engine
  HarnessArtifacts --> Harness
  Harness -. events and capabilities .-> Adapter
```

---

## Step-to-Layer Map

| Step in diagram | Layer / package | What happens there |
| --- | --- | --- |
| User or Project | Outside Weave | Provides project goals, local files, and optional `.weave` configuration. |
| Configuration Sources | `@weaveio/weave-config` | Collects built-in defaults plus global and project config layers. |
| Load + Normalize Config | `@weaveio/weave-config` with `@weaveio/weave-core` | Discovers config, parses and validates the DSL, resolves prompt references, and merges layers. |
| Normalized Weave Config | Output of `@weaveio/weave-config`; input to `@weaveio/weave-engine` | Carries the single merged intent model consumed by the engine. |
| Compose System Plan | `@weaveio/weave-engine` | Builds harness-agnostic agent descriptors, prompt intent, category shuttles, workflows, policies, model intent, and skill intent. |
| Harness-Owned Context | Adapter / harness boundary | Supplies facts only the harness can know, such as selected models, available models, available skills, and lifecycle events. |
| Adapter Translator | `@weaveio/weave-adapter-*` | Translates engine output and harness context into target-specific behavior. |
| Harness Artifacts | `@weaveio/weave-adapter-*` | Produces plugins, config, commands, concrete tool permissions, and runtime wiring for the target harness. |
| Harness Runtime | Harness | Runs the concrete integration in OpenCode, Pi, Claude Code, Codex, or another target. |
| Running Agent Experience | Harness | Hosts the user-facing agents, delegated specialists, reviews, audits, and workflows. |

---

## Flow by Layer

### 1. Configuration describes intent (outside Weave / config input)

Configuration is where users declare what they want the agent system to be:

- agents and their roles
- categories and routing hints
- workflows and gates
- prompt text or prompt references
- model preferences
- skill references
- abstract tool and policy permissions
- disabled agents, hooks, or skills

Built-in defaults, global user preferences, and project-specific overrides are treated as configuration layers. Together they describe the desired agent system before any harness-specific behavior is involved.

### 2. The config packages normalize input (`@weaveio/weave-config` + `@weaveio/weave-core`)

The config packages turn those configuration layers into one normalized configuration:

1. Read available configuration layers.
2. Parse the `.weave` DSL.
3. Validate the parsed structure.
4. Resolve prompt references into usable prompt inputs.
5. Merge built-in, global, and project intent into one final config.

The output is not a harness plugin or runtime object. It is still Weave-owned, harness-agnostic intent.

### 3. The engine composes the system plan (`@weaveio/weave-engine`)

The engine answers: **what should exist?**

It takes normalized configuration and produces higher-level Weave concepts such as:

- normalized agent descriptors
- generated category shuttle agents
- prompt and delegation intent
- model preference intent
- skill matching decisions from adapter-provided skill context
- abstract policy and lifecycle decisions
- workflow execution intent
- durable Runtime Store records under `.weave/runtime/**`

The engine does not inspect harness UI state, discover harness resources, or register concrete runtime hooks. When it needs harness facts, the adapter passes those facts in explicitly. The one filesystem-side-effect exception is Weave-owned Runtime Store state under `.weave/runtime/**`, which remains distinct from harness-owned runtime state.

### 4. The adapter translates intent for one harness (`@weaveio/weave-adapter-*`)

The adapter answers: **how does this work in this specific harness?**

It owns target-specific concerns such as:

- discovering available harness models
- reading selected model state if the harness exposes it
- discovering and loading harness skills
- mapping abstract tool permissions to concrete tool names
- turning agent descriptors into harness-specific agent definitions
- registering harness commands, plugins, hooks, or runtime callbacks
- emulating missing features when the harness does not support them natively

Adapters consume the engine output and materialize it in the target harness.

### 5. The harness runs the experience (harness runtime)

The harness is the concrete execution environment. It presents the UI, runs tools, invokes models, emits lifecycle events, and hosts the final agent experience.

At runtime, harness events flow back to the adapter. The adapter maps those events into Weave's abstract policy surfaces where applicable, keeping harness details out of the engine.

---

## Easy Explanation

Use this wording when explaining Weave's architecture:

> The `.weave` config says what agent system I want. The config layer turns built-in, global, and project settings into one normalized intent model. The engine composes that model into harness-agnostic agents, prompts, policies, and workflows. The adapter knows the target harness, supplies harness context back into the engine when needed, and translates the engine output into concrete harness behavior. The harness then runs the agents.

---

## Ownership Summary

| Layer | Main Question | Owns | Must Not Own |
| --- | --- | --- | --- |
| Configuration | What did the user declare? | Agents, categories, workflows, prompts, policies, preferences | Harness runtime state |
| Config Layer | How do declarations become one valid config? | Parsing, validation, prompt reference resolution, merging | Harness translation |
| Engine | What agent system should exist? | Descriptors, prompt composition, category shuttles, abstract policy, model and skill intent | Harness discovery or concrete callbacks |
| Adapter | How does this system work here? | Harness context, translation, feature-gap emulation, concrete tools and hooks | DSL ownership |
| Harness | Where does it run? | UI, runtime, model/tool execution, lifecycle events | Weave's normalized config semantics |

---

## Key Boundary Rule

The engine may compose Weave intent, but it should not make harness-specific assumptions. If a decision requires knowing what a harness supports, what the user selected in a harness UI, where a harness stores resources, or how a harness registers callbacks, that decision belongs in the adapter.
