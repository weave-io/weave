# 18-spec-delegation-exclusion.md

## Introduction/Overview

Add a per-router delegation exclusion surface that lets individual router agents (e.g. Loom, Tapestry) suppress specific targets from their own delegation table without disabling those targets globally. This solves the common need to keep an agent available for some routers while hiding it from others — for example, keeping `warp` reachable from Tapestry while preventing Loom from delegating to it directly.

The feature is expressed entirely in the `.weave` DSL via a new `routing { }` block on `agent` declarations. The `routing` block is intentionally strict (unknown keys are rejected) to surface typos early. It is also designed as an open extension point: future routing fields such as `priority`, `fallback`, and `weighted_routes` will be added to the same block without breaking existing configs.

## Goals

- Provide a DSL surface for per-router delegation exclusion that does not affect global agent availability.
- Filter excluded targets inside `buildDelegationTargets()` in `packages/engine/src/compose.ts`.
- Emit a debug-level log (not a validation error) when an exclusion entry names an agent that is not present in the resolved config, to support forward references across config layers.
- Document the `routing { }` block as an open extension point for future routing fields.
- Keep the `disabled.agents` mechanism orthogonal: excluding an already-disabled agent is a no-op.

## User Stories

- **As a Loom author**, I want to exclude `warp` from Loom's delegation table so that Loom never routes to `warp` directly, while Tapestry can still delegate to `warp` normally.
- **As a config author**, I want unknown keys inside `routing { }` to be rejected at parse time so that typos like `delegation_exclud` are caught immediately.
- **As a multi-layer config author**, I want to reference agent names in `delegation_exclude` that are only defined in the project layer from the global layer without causing a validation error, so that global configs can anticipate project-level agents.
- **As an adapter author**, I want the exclusion to be applied before `delegationTargets` is populated in `AgentDescriptor` so that I receive a pre-filtered list and do not need to re-implement exclusion logic.

## DSL Syntax

The `routing` block is a new optional sub-block inside `agent` declarations:

```weave
agent loom {
  description "Loom (Main Orchestrator)"
  prompt_file "loom.md"
  models ["claude-sonnet-4-5"]
  mode primary
  temperature 0.1

  tool_policy {
    read allow
    write allow
    execute allow
    delegate allow
    network ask
  }

  routing {
    delegation_exclude ["warp"]
  }
}
```

### Syntax Rules

- `routing { }` is an optional block; omitting it is equivalent to `routing { delegation_exclude [] }`.
- `delegation_exclude` is an optional array of agent name strings inside `routing { }`.
- The `routing` block is **strict**: any key other than `delegation_exclude` (and future documented fields) is rejected at parse/validation time with a clear error message. This is intentional — it surfaces typos such as `delegation_exclud` or `delegationExclude` immediately rather than silently ignoring them.
- Agent names in `delegation_exclude` are plain strings matching the logical agent name (e.g. `"warp"`, `"shuttle-backend"`).

## Schema Addition

`AgentConfigSchema` in `packages/core/src/schema.ts` gains an optional `routing` object:

```ts
/**
 * Per-agent routing configuration.
 *
 * This block is intentionally strict (`.strict()`) so that typos in field
 * names are caught at validation time rather than silently ignored.
 *
 * Open for future routing fields:
 *   - `priority`        — numeric weight for router preference ordering
 *   - `fallback`        — agent name to delegate to when this agent is unavailable
 *   - `weighted_routes` — map of target → weight for probabilistic routing
 *
 * Add new fields here when those specs land; do not add them outside this block.
 */
export const AgentRoutingConfigSchema = z
  .object({
    /**
     * Agent names to exclude from this agent's delegation table.
     * Entries that do not match a known agent at validation time produce a
     * debug-level log only — no validation error — to support forward
     * references between global and project config layers.
     */
    delegation_exclude: z.array(z.string()).optional(),
  })
  .strict();

export const AgentConfigSchema = z
  .object({
    // ... existing fields ...
    routing: AgentRoutingConfigSchema.optional(),
  })
  // ... existing .refine() calls ...
```

The inferred type is exported as:

```ts
export type AgentRoutingConfig = z.infer<typeof AgentRoutingConfigSchema>;
```

`AgentConfig` gains `routing?: AgentRoutingConfig` automatically via `z.infer<typeof AgentConfigSchema>`.

## Semantics

### Filtering in `buildDelegationTargets()`

`buildDelegationTargets()` in `packages/engine/src/compose.ts` currently applies these exclusion guards (in order):

1. Skip self (`targetName === agentName`).
2. Skip globally disabled agents (`config.disabled.agents.includes(targetName)`).
3. Skip `primary`-mode agents.
4. Skip shared shuttle targets for shuttle-equivalent agents (`shouldExcludeSharedShuttleTarget`).

The new exclusion is inserted as guard **5**, after the existing guards:

```ts
function buildDelegationTargets(
  agentName: string,
  agentConfig: AgentConfig,
  config: WeaveConfig,
  allAgents: Record<string, AgentConfig>,
): DelegationTarget[] {
  if (agentConfig.tool_policy?.delegate !== "allow") return [];

  const excluded = new Set(agentConfig.routing?.delegation_exclude ?? []);
  const targets: DelegationTarget[] = [];

  for (const [targetName, targetConfig] of Object.entries(allAgents)) {
    if (targetName === agentName) continue;
    if (config.disabled.agents.includes(targetName)) continue;
    if (targetConfig.mode === "primary") continue;
    if (shouldExcludeSharedShuttleTarget(agentName, agentConfig, targetName)) continue;
    if (excluded.has(targetName)) continue;   // ← new guard

    targets.push({
      name: targetName,
      description: targetConfig.description,
      triggers: targetConfig.triggers ?? [],
    });
  }

  return targets;
}
```

The exclusion check is a simple `Set.has()` lookup — O(1) per target, no sorting or reordering side-effects.

### Debug Log for Unknown Exclusion Entries

When `delegation_exclude` contains a name that does not appear in the resolved `allAgents` map, the engine emits a **debug-level** log and continues. No validation error is raised.

Rationale: global config layers may reference agents that are only defined in the project layer. Treating unknown names as errors would break valid multi-layer configs. Debug level (not warn) is appropriate because the condition is expected and benign during normal layered config use.

```ts
for (const name of excluded) {
  if (!(name in allAgents)) {
    log.debug(
      { agent: agentName, excludedTarget: name },
      "delegation_exclude entry does not match a known agent; skipping",
    );
  }
}
```

This log is emitted once per `buildDelegationTargets()` call, before the main loop.

### Interaction with `disabled.agents`

`disabled.agents` is checked **before** `delegation_exclude` in the guard chain. If a name appears in both `disabled.agents` and `delegation_exclude`, the disabled guard fires first and the exclusion guard is never reached. The net result is identical (the target is absent from the delegation table), so the overlap is a no-op from the caller's perspective.

There is no warning or error for this overlap — it is valid and expected when a config author disables an agent globally and also lists it in a router's `delegation_exclude` for clarity or future-proofing.

### Scope: Per-Router, Not Global

`delegation_exclude` is scoped to the agent that declares it. It has no effect on other agents' delegation tables. In the worked example below, `warp` remains a valid delegation target for Tapestry even though Loom excludes it.

## Worked Example

### Scenario

- `loom` is the primary orchestrator. It should never delegate to `warp` (security review agent) directly — Tapestry handles that routing.
- `tapestry` is a planning agent that can delegate to `warp` for security review.
- `warp` must remain globally available and reachable from Tapestry.

### Config

```weave
agent loom {
  description "Loom (Main Orchestrator)"
  prompt_file "loom.md"
  models ["claude-sonnet-4-5"]
  mode primary
  temperature 0.1

  tool_policy {
    read allow
    write allow
    execute allow
    delegate allow
    network ask
  }

  routing {
    delegation_exclude ["warp"]
  }
}

agent tapestry {
  description "Tapestry (Planner)"
  prompt_file "tapestry.md"
  models ["claude-sonnet-4-5"]
  mode subagent
  temperature 0.2

  tool_policy {
    read allow
    write allow
    execute allow
    delegate allow
    network deny
  }

  # No routing block — warp is visible to Tapestry
}

agent warp {
  description "Warp (Security Reviewer)"
  prompt_file "warp.md"
  models ["claude-sonnet-4-5"]
  mode subagent
  temperature 0.0

  tool_policy {
    read allow
    write deny
    execute deny
    delegate deny
    network deny
  }
}

agent shuttle {
  description "Shuttle (Domain Specialist)"
  prompt_file "shuttle.md"
  models ["claude-sonnet-4-5"]
  mode all
  temperature 0.2

  tool_policy {
    read allow
    write allow
    execute allow
    delegate deny
  }
}
```

### Expected Delegation Tables

| Router | Delegation targets | `warp` visible? |
|---|---|---|
| `loom` | `tapestry`, `shuttle` | **No** — excluded via `routing.delegation_exclude` |
| `tapestry` | `shuttle`, `warp` | **Yes** — no exclusion declared |

`warp` is not disabled globally. It is reachable from Tapestry and any other agent that does not explicitly exclude it.

### Prompt Template Output

Because `loom` excludes `warp`, the `{{{delegation.section}}}` rendered into Loom's prompt will contain only `tapestry` and `shuttle` in its Mermaid diagram and bullet list. Tapestry's rendered prompt will include `shuttle` and `warp`.

## Validation Behaviour

| Condition | Behaviour |
|---|---|
| `routing` block omitted | Treated as `routing { delegation_exclude [] }` — no exclusions |
| `delegation_exclude` omitted inside `routing { }` | Treated as empty — no exclusions |
| Unknown key inside `routing { }` (e.g. `delegation_exclud`) | **Validation error** — `.strict()` rejects unknown keys |
| Entry in `delegation_exclude` names a known agent | Filtered from delegation table silently |
| Entry in `delegation_exclude` names an unknown agent | **Debug log only** — no validation error |
| Entry in `delegation_exclude` names a disabled agent | No-op — disabled guard fires first; debug log still emitted for unknown-agent case |
| Entry in `delegation_exclude` names self | No-op — self-exclusion guard fires first |

## Interaction with Prompt Templates

The `{{{delegation.section}}}` template placeholder and the `{{#delegation.targets}}` iteration context both reflect the **post-exclusion** delegation target list. Adapters and prompt templates always receive the filtered list; they do not need to re-apply exclusion logic.

See [`docs/prompt-composition.md`](../../prompt-composition.md) for the full template context specification.

## Interaction with the Materialization API

The materialization API (`materializeAgentDescriptors()` from `@weaveio/weave-engine`, specified in [Spec 15](../15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md)) calls `composeAgentDescriptor()`, which calls `buildDelegationTargets()`. Because exclusion is applied inside `buildDelegationTargets()`, materialized `AgentDescriptor.delegationTargets` arrays are already filtered. Adapters receive pre-filtered lists and do not need to inspect `routing.delegation_exclude` themselves.

## Non-Goals (Out of Scope)

1. **Global exclusion**: This spec does not add a top-level `delegation_exclude` that applies across all routers. Use `disable agents [...]` for global suppression.
2. **Exclusion of categories**: Category shuttle names (e.g. `shuttle-backend`) can be listed in `delegation_exclude` and will be filtered, but this spec does not add category-aware exclusion patterns (e.g. `"shuttle-*"`).
3. **Priority or weighted routing**: The `routing { }` block is designed to hold these fields in future specs, but they are not implemented here.
4. **Bidirectional exclusion**: Excluding `warp` from Loom does not prevent `warp` from delegating back to Loom (if `warp` had `delegate allow`).
5. **Runtime enforcement**: Exclusion is a config-composition concern. The engine filters delegation targets at descriptor composition time. Runtime enforcement (preventing an agent from actually calling another) is adapter-owned.

## Design Considerations

### Why `.strict()` on `routing { }`?

The `routing` block uses `.strict()` (unknown keys rejected) rather than `.passthrough()` or `.strip()`. This is a deliberate trade-off:

- **Benefit**: Typos like `delegation_exclud` or `delegationExclude` are caught immediately at validation time with a clear error message, rather than silently ignored.
- **Cost**: Adding a new field to `routing { }` in a future spec requires a schema update. This is acceptable because new routing fields are expected to be infrequent and well-specified.
- **Precedent**: `ToolPolicySchema` uses `.strict()` for the same reason.

### Why debug-level (not warn) for unknown exclusion entries?

Unknown entries in `delegation_exclude` are expected in layered configs where a global config references agents defined only in the project layer. Warn-level would produce noise in normal multi-layer setups. Debug-level is visible when diagnosing routing issues but silent in production.

### Why insert exclusion as guard 5 (after disabled)?

Checking `disabled.agents` first preserves the invariant that disabled agents are never surfaced in delegation tables regardless of other config. Exclusion is a secondary, per-router concern. The ordering also means the debug log for unknown exclusion entries is only emitted for agents that are not already disabled — reducing noise.

## Repository Standards

- Follow the engine/adapter boundary in `docs/adapter-boundary.md`: exclusion logic lives in the engine (`buildDelegationTargets()`); adapters receive pre-filtered `delegationTargets` and must not re-implement exclusion.
- Use `neverthrow` for fallible functions. `buildDelegationTargets()` is currently pure and synchronous; the debug log addition does not change its return type.
- Use the shared pino logger from `@weaveio/weave-engine` for the debug log. Never use `console.*`.
- Schema changes must be reflected in tests at all four levels: unit (schema), transform (validate), and E2E (parse_config). See the testing table in `AGENTS.md`.
- Mention the relevant GitHub issue in any Pull Request created for this work.

## Technical Considerations

- `AgentRoutingConfigSchema` should be defined as a named export in `packages/core/src/schema.ts` so adapters and tests can import it directly.
- The `Set` construction from `delegation_exclude` should happen once per `buildDelegationTargets()` call, not inside the inner loop.
- The debug log for unknown entries should iterate the `excluded` set before the main target loop to avoid interleaving log output with target processing.
- The `routing` field on `AgentConfig` is optional; `agentConfig.routing?.delegation_exclude ?? []` is the safe access pattern.
- No changes to `AgentDescriptor` are required — `delegationTargets` already carries the filtered list.
- The `routing` block is parsed by the existing DSL parser. The parser already handles nested blocks with key-value pairs and arrays; no lexer or parser changes are expected for the initial `delegation_exclude` field.

## Security Considerations

- `delegation_exclude` is a config-layer filter, not a security boundary. It controls which agents appear in a router's delegation table but does not prevent an agent from being invoked by other means.
- The debug log must not emit prompt content, model names, or other sensitive config values — only the agent name and excluded target name.
- Adapters must not expose `routing.delegation_exclude` raw values to harness UI or generated config files unless explicitly required by a future spec.

## Success Metrics

1. **DSL acceptance**: A `.weave` config with `routing { delegation_exclude ["warp"] }` parses and validates without error.
2. **Filtering correctness**: `buildDelegationTargets()` omits excluded targets from the returned list.
3. **No global side-effects**: Excluded targets remain in the delegation tables of other agents that do not declare the exclusion.
4. **Debug log on unknown entry**: An exclusion entry naming an unknown agent emits exactly one debug log and does not cause a validation error.
5. **Strict block enforcement**: An unknown key inside `routing { }` produces a validation error.
6. **Test coverage**: Schema, validate, and parse_config tests cover the new `routing` field at all four levels per `AGENTS.md`.

## Open Questions

1. Should `delegation_exclude` support glob patterns (e.g. `"shuttle-*"`) in a future spec, or should category-level exclusion be handled via a separate `routing.exclude_categories` field?
2. Should the debug log for unknown exclusion entries be promoted to warn-level when the config has no global layer (i.e. only a project config), where forward references are less likely?
3. Should a future `routing.priority` field be a per-target map or a single numeric weight applied to all targets from this router?
