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
- **Fallback delegation for static prompts.** If a prompt source does not reference any `delegation.*` path, the engine appends `delegation.section` automatically. This preserves backward compatibility: existing static prompts continue to receive delegation guidance without modification.
- **Fallback suppression by reference.** If the primary prompt source contains a real `delegation.*` Mustache reference (variable, section, or inverted section), the engine does not append the fallback. This lets prompt authors control placement explicitly with `{{{delegation.section}}}`.
- **Strict path validation.** The renderer validates every referenced path against an explicit allowed-path list. Typos fail at composition time. Unsafe paths (`__proto__`, `prototype`, `constructor`) are rejected. Function values are rejected to prevent Mustache lambdas.
- **Escaped literal tags.** `\{{path}}` renders as the literal text `{{path}}` and does not count as a template reference. This allows prompt authors to show template syntax as documentation without triggering rendering.

The Template Context first slice exposes:

- `agent.name`, `agent.description`, `agent.mode`, `agent.skills`, `agent.isCategory`
- `category.name`, `category.description` (only for category shuttle agents)
- `toolPolicy.effective.read/write/execute/delegate/network`
- `delegation.targets[]` with `name`, `description`, `domains[]`, `triggers[]`
- `delegation.section` — canonical Markdown with `## Delegation`, Mermaid `flowchart TD`, and compact bullets
- `delegation.mermaid` — just the Mermaid block

---

## Consequences

### What changes

- `prompt`, `prompt_file`, and `prompt_append` are now rendered as Mustache templates by the engine before adapters receive the composed prompt.
- The engine generates a **Delegation Diagram** (Mermaid `flowchart TD` + compact bullets) and exposes it through the Template Context as `delegation.section` and `delegation.mermaid`.
- Builtin prompt files (`loom.md`, `tapestry.md`) now use `{{{delegation.section}}}` to place delegation guidance where it fits naturally in the prompt flow.
- `ComposeError` gains a `PromptTemplateError` variant with typed nested reasons for malformed syntax, unsupported tags, unknown paths, unsafe paths, function values, section mismatch, and unresolved tags.

### What is now possible

- Prompt authors can place `{{{delegation.section}}}` anywhere in a prompt file to control where delegation guidance appears.
- Prompt authors can reference `{{agent.name}}`, `{{agent.mode}}`, `{{toolPolicy.effective.read}}`, and other Template Context fields to write prompts that adapt to config without duplication.
- Prompt authors can suppress the fallback delegation section entirely by referencing any `delegation.*` path in the primary prompt source.
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
