# ADR 0013: Delegation Targets Come from Materialized Agents, Not Config

**Status**: Accepted
**Date**: 2026-09-25
**Related**: [Spec 38 — Delegation Accuracy](../specs/38-spec-delegation-accuracy/38-spec-delegation-accuracy.md) (item 2, root cause b) · [Adapter Boundary](../adapter-boundary.md#agent-materialization-api) · [Prompt Composition](../prompt-composition.md#delegation-filtering-rules) · [Spec 15 — Adapter-Facing Materialization API](../specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) · [ADR 0001 — Prompt Composition Templates](0001-prompt-composition-templates.md) · [ADR 0010 — OpenCode V2 Adapter](0010-opencode2-independent-adapter.md)

---

## Context

Loom's and Tapestry's prompts list the agents they may delegate to. The list is rendered by the engine from `delegation.targets` while it composes each prompt ([`compose.ts`](../../packages/engine/src/compose.ts)). Until this decision the list was built from the merged config: every agent that was declared, generated from a category, or generated as a review variant, minus the [filtering rules](../prompt-composition.md#delegation-filtering-rules).

What the harness ends up holding is not the same set. An agent can fail after config resolution:

| Failure | Where it is detected | Example |
| --- | --- | --- |
| Its prompt does not compose | Engine, during `materializeAgents()` | a category whose `prompt_append` names `{{nope}}` → `shuttle-broken` |
| Its model does not resolve | Adapter | an OpenCode V1 subagent whose declared model is not in the host's catalog |
| Its descriptor does not translate | Adapter | a descriptor the harness config cannot express |
| Its name is already held | Adapter, against the live host | on OpenCode V2, another plugin registered `shuttle-web` first; Weave never inserts its own |

In each case Loom was still told the agent existed. The September 2026 session audit found every category-shuttle delegation failing for this family of reasons, and Spec 38's L1 contract test ([`delegation-contract.scenario.test.ts`](../../tests/adapters/delegation-contract.scenario.test.ts)) caught `shuttle-broken` on both OpenCode adapters and `shuttle-web` on OpenCode V2.

Two constraints shape the fix:

1. **The boundary.** Which agents a harness accepted is harness knowledge. The engine may not query the harness; the adapter must hand it over as explicit context ([Adapter Boundary](../adapter-boundary.md#boundary-rule)).
2. **The order.** Prompts are composed before the adapter registers anything, and the delegation list is part of the composed prompt. The outcome of registration is known only after composition.

## Decision

### 1. The engine offers only agents that composed

`materializeAgents()` never offers an agent whose own descriptor failed to compose. Composition is engine work, so the engine needs no report for this: after composing every agent it re-composes, with a narrower candidate set, only the agents whose delegation list (or review routing) offered one that failed. This helps every caller — CLI, Claude Code, Pi, Copilot — without any adapter change.

### 2. The adapter reports what the harness holds

`MaterializationInput` gains an optional `harness: HarnessMaterializationReport`:

```ts
interface HarnessMaterializationReport {
  materialized: readonly string[];      // agents the harness holds under Weave's ownership
  failed: readonly UnavailableAgent[];  // agents it did not take, each with a reason
}

interface UnavailableAgent {
  agentName: string;
  reason: "composition_failed" | "model_unresolved" | "translation_failed"
        | "name_taken" | "not_reported";
  message?: string;
}
```

With a report, an agent is a delegation candidate only if it is listed in `materialized` and not in `failed`. An agent the report does not mention at all is excluded as `not_reported`.

### 3. Compose, then register, then re-compose only when something was refused

The engine does not own the harness, so it cannot know the outcome before the adapter acts. Rather than splitting composition into phases, the adapter calls `materializeAgents()` a second time with its report — and only when it refused something:

- **OpenCode V1** ([`materialize-agents.ts`](../../packages/adapters/opencode/src/materialize-agents.ts)): compose → resolve models and translate → if any agent was refused (`model_unresolved`, `translation_failed`), compose again with the report and translate that plan. OpenCode V1's config hook overwrites any agent of the same name, so V1 has no `name_taken` case.
- **OpenCode V2** ([`catalog.ts`](../../packages/adapters/opencode2/src/v2/catalog.ts), [`plugin.ts`](../../packages/adapters/opencode2/src/v2/plugin.ts)): the collision is known *before* composition. The catalog build reads the host's agent list and passes the ids Weave did not insert as `heldAgents`; if any of Weave's agents has one of those names, the catalog composes again with a report marking it `name_taken`. The agent transform keeps its own collision guard, so a collision the build did not foresee still never overwrites a foreign agent.

When nothing is refused — the normal case — each adapter composes once, exactly as before.

### 4. Each exclusion is a result and a log line

`MaterializationPlan` gains `unavailableAgents: readonly UnavailableAgent[]`. The engine also logs each one at `warn` through `logger.child({ module: "materialization" })` with structured `agent`, `reason` and `message` fields. When no report is given it logs once per call, at `debug`, that targets are drawn from every agent that composes.

### 5. No report means today's behaviour, minus composition failures

An adapter that passes no report gets the config-based list, filtered only by what failed to compose. Claude Code, Pi and Copilot work unchanged.

## Consequences

**Positive**

- Loom and Tapestry are never offered an agent the harness does not hold, on either OpenCode adapter; the L1 "offers only agents the harness holds" assertions pass for every fixture.
- OpenCode V2's native `subagent` permissions, which are built from the same `delegationTargets`, stop allowing a spawn of the foreign agent that holds Weave's name.
- The engine stays harness-neutral: it filters a set it was given and returns a normalized result.
- Other adapters benefit from rule 1 with no change.

**Negative / costs**

- A refused agent costs one extra composition pass. The V2 catalog's prompt reader is cached, so no file is read twice there; V1 reads prompt files again through the default reader.
- A report describes the harness at one moment. On V2 the held-agent set is captured when the catalog is built; a plugin that registers a colliding agent later is not reflected until the next catalog refresh. The held set is part of the catalog revision, so a refresh after it changes does rebuild.
- `composeAgentDescriptor()` gains a trailing optional `delegationCandidates` parameter.

**Neutral**

- A refused agent's descriptor is still returned in `plan.agents`, so adapters and diagnostics can still report on it. OpenCode V2 keeps its projection so `status` can count the collision.
- The recomposition loop is bounded by the number of agents. In practice it runs at most once, because an agent's own composition does not depend on which targets it is offered.
