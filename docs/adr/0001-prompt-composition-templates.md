# ADR 0001: Prompt Composition Templates

**Status**: Accepted  
**Date**: 2026-05-19  
**Related**: [Prompt Composition Guide](../prompt-composition.md) · [Adapter Boundary](../adapter-boundary.md) · [Context Glossary](../../CONTEXT.md)

---

## Context

Weave's engine composes each agent's final prompt before handing the agent to an adapter. Prior to this decision, prompt composition was purely internal string building: the engine appended a generated `## Delegation` section to every delegating agent's prompt, with no mechanism for prompt authors to control placement, suppress the section, or embed other engine-owned data.

This created two problems:

1. **Placement is fixed.** Delegation guidance always appeared at the end of the prompt, regardless of where it would be most useful for the agent's reasoning flow.
2. **No dynamic data in prompts.** Prompt authors could not reference engine-computed values (agent name, mode, effective tool policy, delegation targets) without duplicating that data by hand — which would diverge from config.

The engine needed a way to let prompt files express intent about where and how engine-owned data appears, without exposing raw internal config shapes or introducing harness-specific behavior.

---

## Decision

Weave renders `prompt`, `prompt_file`, and `prompt_append` as **Mustache Prompt Templates** during engine prompt composition, using a bounded **Template Context** and a safe Mustache wrapper.

Key constraints on the decision:

- **Mustache, not Handlebars or Jinja.** Mustache has no helpers, no partials, no executable behavior, and no filesystem access. This keeps the template surface minimal and safe.
- **Bounded context, not raw config.** The Template Context is an explicit projection of engine-computed data. It does not expose `WeaveConfig`, `AgentConfig`, model lists, file paths, or any internal shape. Schema evolution does not break the template API.
- **Engine-owned, not adapter-owned.** Prompt composition is a pure interpretation of Weave config. Adapters receive the final **Composed Prompt** and must not re-implement composition rules.
- **Strict path validation.** The renderer validates every referenced path against an explicit allowed-path list. Typos fail at composition time. Unsafe paths (`__proto__`, `prototype`, `constructor`) are rejected. Function values are rejected to prevent Mustache lambdas.
- **Escaped literal tags.** `\{{path}}` renders as the literal text `{{path}}` and does not count as a template reference. This allows prompt authors to show template syntax as documentation without triggering rendering.

The Template Context first slice exposes:

- `agent.name`, `agent.description`, `agent.mode`, `agent.skills`, `agent.isCategory`
- `category.name`, `category.description` (only for category shuttle agents)
- `toolPolicy.effective.read/write/execute/delegate/network`
- `delegation.targets[]` with `name`, `description`, `domains[]`, `triggers[]`

---

## Consequences

### What changes

- `prompt`, `prompt_file`, and `prompt_append` are now rendered as Mustache templates by the engine before adapters receive the composed prompt.
- `ComposeError` gains a `PromptTemplateError` variant with typed nested reasons for malformed syntax, unsupported tags, unknown paths, unsafe paths, function values, section mismatch, and unresolved tags.

### What is now possible

- Prompt authors can reference `{{agent.name}}`, `{{agent.mode}}`, `{{toolPolicy.effective.read}}`, and other Template Context fields to write prompts that adapt to config without duplication.
- Prompt authors can use `\{{path}}` to show template syntax as documentation without triggering rendering.
- Category shuttle agents can use `{{#category}}...{{/category}}` to conditionally render category-specific content.

### What is now forbidden

- Partials (`{{> footer}}`), delimiter changes (`{{=<% %>=}}`), helpers, lambdas, and executable template behavior are rejected at composition time.
- Referencing paths not in the allowed-path list fails composition with a typed `UnknownPath` error.
- Referencing `__proto__`, `prototype`, `constructor`, or other unsafe paths fails with `UnsafePath`.
- Function values in the Template Context are rejected before rendering to prevent Mustache lambda execution.
- Adapters must not re-implement prompt composition rules; they receive the final `composedPrompt` string.

### What is deferred

- Workflow step prompt templating is conceptually aligned with this decision but not implemented in this slice. Future workflow rendering should reuse the same renderer with a workflow-specific Template Context.
- Skill content is not yet part of the composed prompt. `skills` is a passthrough field on `AgentDescriptor` pending issue #12.

---

## Amendment — 2026-05-22

**Decision**: Remove `delegation-section` and `delegation-mermaid` from the template context.

**Rationale**: No builtin prompt file ever used `{{{delegation-section}}}` or `{{{delegation-mermaid}}}` in practice. The `{{#delegation.targets}}` loop is sufficient and more composable — prompt authors can iterate over structured data and format it however they need, rather than receiving a pre-rendered opaque string. The pre-rendered strings were redundant with the structured data already available via `delegation.targets`, added maintenance surface for the Mermaid generation logic, and created a false impression that delegation guidance required a specific visual format. Removing them simplifies the Template Context and keeps the engine focused on structured data rather than presentation.

**What changed**:

- `delegation-section` and `delegation-mermaid` removed from the Template Context and the allowed-path list.
- Fallback delegation appending (static prompts receiving `delegation-section` automatically) removed.
- Fallback suppression logic (detecting `delegation.*` references to skip the append) removed.
- Mermaid diagram generation code removed from the engine.
- All references in builtin prompt files, engine source, and tests updated accordingly.
