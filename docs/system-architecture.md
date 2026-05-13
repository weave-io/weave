# System Architecture

This diagram is intentionally high level. It describes the conceptual flow of Weave without relying on specific source files or implementation details.

**Related:** [Product Vision](product-vision.md) · [Adapter Boundary](adapter-boundary.md) · [Config Loading](config-loading.md) · [Model Resolution](model-resolution.md)

---

## One-Sentence Mental Model

Weave turns a declarative `.weave` configuration into normalized agent intent, lets the engine compose that intent into a harness-agnostic system plan, and lets adapters translate that plan into concrete behavior inside a target harness.

---

## System Diagram

```mermaid
architecture-beta
  group configuration(cloud)[Configuration]
  group weave(cloud)[Weave Core]
  group target(cloud)[Target Harness]

  service user(server)[User or Project] in configuration
  service sources(database)[Built-ins Global Project] in configuration

  service configLayer(server)[Config Layer Parse Validate Resolve Merge] in weave
  service normalized(database)[Normalized Weave Config] in weave
  service engine(server)[Engine Compose Intent] in weave

  service adapter(server)[Adapter Translator] in target
  service context(database)[Harness Context Models Skills Events] in target
  service artifacts(disk)[Harness Artifacts Plugins Config Tools Hooks] in target
  service harness(internet)[Harness Runtime] in target
  service agents(server)[Running Agent Experience] in target

  user:R --> L:sources
  sources:R --> L:configLayer
  configLayer:R --> L:normalized
  normalized:R --> L:engine
  engine:R --> L:adapter

  context:B --> T:adapter
  adapter:L --> R:engine

  adapter:R --> L:artifacts
  artifacts:R --> L:harness
  harness:R --> L:agents
  harness:T --> B:adapter
```

---

## Flow by Layer

### 1. Configuration describes intent

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

### 2. The config layer normalizes input

The config layer turns those configuration layers into one normalized configuration:

1. Read available configuration layers.
2. Parse the `.weave` DSL.
3. Validate the parsed structure.
4. Resolve prompt references into usable prompt inputs.
5. Merge built-in, global, and project intent into one final config.

The output is not a harness plugin or runtime object. It is still Weave-owned, harness-agnostic intent.

### 3. The engine composes the system plan

The engine answers: **what should exist?**

It takes normalized configuration and produces higher-level Weave concepts such as:

- normalized agent descriptors
- generated category shuttle agents
- prompt and delegation intent
- model preference intent
- skill matching decisions from adapter-provided skill context
- abstract policy and lifecycle decisions
- workflow execution intent

The engine does not inspect harness UI state, discover harness resources, or register concrete runtime hooks. When it needs harness facts, the adapter passes those facts in explicitly.

### 4. The adapter translates intent for one harness

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

### 5. The harness runs the experience

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
