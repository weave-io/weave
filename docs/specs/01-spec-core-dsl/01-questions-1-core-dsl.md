# 01 Questions Round 1 - Core DSL

Please answer each question below (select one or more options, or add your own notes). Feel free to add additional context under any question.

## 1. Prompt Composition Model

How should agents declare their system prompts in the DSL? This is the core design decision — it determines how builtin agents (Loom, Tapestry, etc.) express their multi-section, partially-dynamic prompts using the same DSL that end users use.

- [ ] (A) **Section array** — `sections: [{ tag: "Role", content: "..." }, { tag: "Delegation", builder: (ctx) => "..." }]` — Follows the sketch in `docs/legacy-architecture.md` §7.2. Each section has a tag, and is either static content or a dynamic builder function receiving a context object.
- [ ] (B) **Simple string + append** — `prompt: "full prompt text"` with optional `prompt_append: "extra"` — Keep it simple like the current `AgentConfig`. Builtin agents construct their full prompt string in their config declaration using helper functions. No first-class section concept in the type system.
- [ ] (C) **Hybrid** — `prompt: string | PromptSection[]` — Support both a simple string (for basic agents) and a section array (for complex composition). The engine normalises both to sections before composing the final prompt.
- [x] (D) Other (describe): it can be either a string, or a file path to a
      prompts file. (.weave/prompts/prompt_a.md)

**Recommended answer(s):** (C)

**Why these are recommended:**

- **(C) Hybrid** lets simple agents stay simple (`prompt: "You are a coder"`) while giving builtin agents and power users the full section-composition machinery (`sections` with tags, static/dynamic content, and builder functions). This satisfies the AGENTS.md mandate ("DSL must be expressive enough to declare the full behaviour of any agent") without forcing every custom agent through a complex section array.
- **(A)** is expressive but verbose for simple use cases — every agent, even a one-line-prompt custom agent, would need to wrap content in a section.
- **(B)** is too limited — builtin agents like Loom/Tapestry have 11-14 composed sections with conditional dynamic content. A flat string can't express this declaratively; it would push composition logic out of the DSL into imperative code, violating the DSL-first principle.

## 2. Tool Policy Shape

How should agents declare which tools they can use?

- [ ] (A) **String array** (current) — `tools: ["read", "execute", "bash"]` — Simple allowlist of tool names.
- [x] (B) **Capability map** — `toolPolicy: { read: "allow", write: "allow", execute: "allow", delegate: "deny" }` — Map of abstract capabilities to `allow`/`deny`/`ask`. Adapters map capabilities to harness-specific tool names. Follows §7.2/§7.3 recommendation.
- [ ] (C) **Both** — `tools?: string[]` for quick declarations + `toolPolicy?: Record<string, boolean>` for fine-grained control. If both are provided, `toolPolicy` wins.
- [ ] (D) Other (describe)

**Recommended answer(s):** (B)

**Why these are recommended:**

- **(B) Capability map** aligns with the harness-agnostic goal. Tool names differ between harnesses (OpenCode has `task`, Claude Code has `Task`, Pi has `dispatch`). Declaring abstract capabilities (`delegate`, `write`, `read`) means the DSL stays portable. The adapter layer maps capabilities to concrete tool names.
- **(A)** couples the DSL to a specific harness's tool names, contradicting the adapter architecture.
- **(C)** adds complexity with two overlapping mechanisms for the same thing. One canonical approach is cleaner.

## 3. Config Surface Scope

How much of the legacy configuration surface should this spec cover? The legacy system has agents, categories, continuation, analytics, workflows, background concurrency, and log level.

- [ ] (A) **Agents only** — Focus this spec on `AgentConfig` (prompt composition, tool policies, model resolution, delegation metadata, modes) and the minimal `WeaveConfig` shell. Categories, continuation, analytics, etc. become separate future specs.
- [x] (B) **Agents + categories** — Agents plus the category/domain routing system (glob patterns, per-category model/tool overrides), since categories directly affect agent behaviour and prompt composition.
- [ ] (C) **Full legacy parity** — Cover the entire legacy config surface in one spec: agents, categories, continuation, analytics, workflows, background, log level, disabled lists.
- [ ] (D) Other (describe)

**Recommended answer(s):** (B)

**Why these are recommended:**

- **(B) Agents + categories** captures the two config areas that are tightly coupled. Categories affect agent prompt composition (§3.2 section 7: CategoryRouting), agent spawning (shuttle-{category} variants), and tool/model resolution — they can't be cleanly separated from agent config without artificial boundaries. Everything else (continuation, analytics, workflows) is orthogonal and can be specced independently.
- **(A)** risks an incomplete type system where builtin agents can't be fully declared (Loom/Tapestry both reference categories in their prompt composition).
- **(C)** is too large for one spec — continuation alone has its own config resolution pipeline, and workflows are a separate domain.

## 4. Runtime Validation

Should `@weave/core` include Zod schemas for runtime validation of config, or only TypeScript types?

- [ ] (A) **TypeScript types only** — `@weave/core` exports pure TS interfaces. Runtime validation (Zod) lives in `@weave/engine` where config is actually loaded and parsed.
- [x] (B) **Types + Zod schemas in core** — Export both the TS types and co-located Zod schemas from `@weave/core`. The schemas are the source of truth; TS types are inferred from them via `z.infer<>`.
- [ ] (C) **Types + lightweight validation** — Export TS types and a `validateConfig(input: unknown): WeaveConfig` function in core that does runtime checks without a Zod dependency.
- [ ] (D) Other (describe)

**Recommended answer(s):** (B)

**Why these are recommended:**

- **(B) Types + Zod** is the most robust approach and follows the legacy system's pattern (§5.1: "Zod schema with graceful degradation"). Co-locating schemas with types in core means any package can validate a config object without depending on engine. Using `z.infer<>` keeps types and schemas in sync — they can never drift.
- **(A)** forces engine (or adapters) to duplicate type knowledge in Zod form, risking drift between TS types and runtime validation.
- **(C)** re-invents Zod poorly. The legacy system already uses Zod successfully.

## 5. Agent Mode

The legacy system has agent modes (`primary`, `subagent`, `all`) that affected OpenCode model resolution. In the harness-agnostic successor, mode remains part of the DSL as adapter-facing agent intent, not as a requirement that core Weave query harness UI state. Should this be part of the DSL?

- [x] (A) **Yes, include `mode`** — Add `mode: "primary" | "subagent" | "all"` to `AgentConfig`. Builtin agents use this to declare their model resolution behaviour. Adapters interpret it for their harness.
- [ ] (B) **No, defer to engine** — Mode is a resolution concern, not a declaration concern. The DSL declares the model/fallback chain; the engine decides resolution strategy.
- [ ] (C) Other (describe)

**Recommended answer(s):** (A)

**Why these are recommended:**

- **(A)** makes mode a first-class declaration. Builtin agent definitions need to express whether an agent is main/user-facing, delegated/specialist, or both. This is agent identity and adapter-facing intent, not a requirement that core Weave resolve UI-selected models. It belongs in the DSL alongside model preferences and temperature.
- **(B)** means builtin agents can't fully self-describe in the DSL — the engine would need out-of-band knowledge of which agents are primary vs subagent, violating the DSL-first principle.

## 6. Model Fallback Chains

How should agents declare model preferences when the primary model is unavailable?

- [ ] (A) **`model` + `fallback_models`** — `model: "claude-sonnet-4-5"`, `fallback_models: ["gpt-4o", "gemini-2-flash"]` — Matches the legacy custom agent config shape.
- [x] (B) **`models` array** — `models: ["claude-sonnet-4-5", "gpt-4o", "gemini-2-flash"]` — Single ordered preference list; adapters can translate it using harness-specific availability/default behavior.
- [ ] (C) **Both** — `model?: string` (single preferred) + `models?: string[]` (full fallback chain). If `model` is set, it's prepended to `models`.
- [ ] (D) Other (describe)

**Recommended answer(s):** (B)

**Why these are recommended:**

- **(B) Single `models` array** is the simplest mental model — one ordered list of preferences. No ambiguity about how `model` and `fallback_models` interact. The first entry is the primary; the rest are fallbacks.
- **(A)** splits a conceptually single list into two fields for no clear benefit.
- **(C)** has the same redundancy issue as (A) plus merge ambiguity.
