# Product Vision

Weave is a harness-agnostic API for building agent-harness experiences. It is closer to Neovim's API layer than to a finished editor: Weave defines the primitives, config model, prompt/delegation structure, and policy intent that adapters compose into concrete harness integrations.

**Related:** [Model Resolution](model-resolution.md) · [Config Loading](config-loading.md) · [Spec 04 — Agent Model Resolution](specs/04-spec-agent-model-resolution/04-spec-agent-model-resolution.md) · [Legacy Architecture](legacy-architecture.md)

---

## Core Mental Model

```txt
.weave DSL
    ↓
parsed + validated config
    ↓
normalized agent descriptors + prompt/delegation intent
    ↓
adapter translation
    ↓
harness runtime/plugin/config
(OpenCode, Pi, Claude Code, Codex, ...)
```

Weave's responsibility is to describe **what agent system should exist**:

- agent topology and names
- prompts and prompt appendices
- delegation metadata for Loom/Tapestry
- categories and generated category shuttle descriptors
- abstract tool/capability policy
- ordered model preferences
- workflow intent

Adapters are responsible for deciding **how that intent becomes harness behavior**:

- harness plugin/config generation
- UI-selected model lookup and interpretation
- available model discovery
- concrete model field selection
- harness-specific tool names and permissions
- command/event/hook registration
- display-name mapping
- runtime-specific lifecycle wiring

---

## Boundary Rules

### Weave Does

- Parse and validate `.weave` files.
- Merge builtin, global, and project config layers.
- Resolve prompt file paths and produce normalized config.
- Build or describe prompts and delegation instructions.
- Generate descriptors for declared agents and category shuttles.
- Expose adapter-facing helpers for common translation policies when useful.

### Weave Does Not

- Query a harness user's currently selected UI model.
- Require harnesses to expose a selected model or available model registry.
- Mutate harness runtime state directly.
- Decide how a specific harness represents agents, commands, tools, or display names.
- Treat legacy OpenCode plugin behavior as universal core behavior.

---

## Adapter Ownership

Adapters consume Weave's normalized intent and produce a concrete harness integration. If a harness supports concepts such as a UI-selected model, model registry, default agent, plugin lifecycle hooks, or display-name remapping, those are adapter concerns.

A shared helper may exist to make adapter behavior consistent, but it must accept harness state as explicit input. It must not reach from core Weave into UI state or runtime APIs.

---

## Legacy Architecture Guidance

[`docs/legacy-architecture.md`](legacy-architecture.md) documents the old OpenCode-specific system. It is useful as a source of implementation ideas and migration context, but it is not the product vision for the harness-agnostic successor.

When legacy behavior conflicts with this document, prefer this document. In particular, legacy model-resolution behavior that depended on OpenCode's UI-selected model should be treated as OpenCode adapter translation behavior, not core Weave behavior.
