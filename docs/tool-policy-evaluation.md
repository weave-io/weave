# Tool Policy Evaluation

Weave evaluates abstract tool policy in the engine layer, producing a fully-resolved
`EffectiveToolPolicy` for every agent before it is materialised by an adapter.
This document describes the vocabulary, evaluation rules, and the observable
effects channel through which callers receive the computed policy.

**Related:** [Adapter Boundary](adapter-boundary.md) · [Product Vision](product-vision.md) · [Spec 08 — Abstract Tool Policy Evaluation](specs/08-spec-abstract-tool-policy-evaluation/08-spec-abstract-tool-policy-evaluation.md) · [Spec 07 — Adapter Capability Contract](specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md)

---

## Purpose

The engine layer owns abstract policy composition. When a `.weave` config declares
a `tool_policy` block for an agent or category, the engine resolves that partial
declaration into a complete, harness-agnostic `EffectiveToolPolicy` before passing
anything to an adapter.

This separation ensures:

- Adapters can access a fully-resolved policy (via `RunAgentEffect` or
  `evaluateEffectiveToolPolicy`) without re-implementing default-filling logic.
- The raw declared policy is also available so adapters can apply harness-specific
  translation (e.g. mapping abstract capabilities to concrete tool names).
- Policy evaluation is pure, deterministic, and testable without a live harness.

---

## The Five Abstract Capabilities

All tool policy in Weave is expressed in terms of five abstract capabilities.
These are the only capability keys the engine recognises. Adapters map them to
concrete harness tool names.

| Capability   | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `read`       | Read access to files, memory, or other data sources                     |
| `write`      | Write access to files, memory, or other data sinks                      |
| `execute`    | Execution of commands, scripts, or processes                            |
| `delegate`   | Spawning sub-agents or delegating work to other agents                  |
| `network`    | Outbound network access (HTTP, WebSocket, etc.)                         |

The canonical list is `ABSTRACT_CAPABILITIES` in
[`packages/engine/src/tool-policy.ts`](../packages/engine/src/tool-policy.ts).
Only an approved spec change may add or remove entries.

---

## `EffectiveToolPolicy`

```ts
type EffectiveToolPolicy = {
  read:     ToolPermission;
  write:    ToolPermission;
  execute:  ToolPermission;
  delegate: ToolPermission;
  network:  ToolPermission;
};
```

`EffectiveToolPolicy` is a **fully-resolved** policy where every capability has
an explicit `ToolPermission` value (`"allow"`, `"deny"`, or `"ask"`). Unlike the
raw `ToolPolicy` from `@weave/core` — which allows optional fields to represent
"not declared" — `EffectiveToolPolicy` requires all five capabilities.

**Why every field is required:** Adapters must not re-implement default-filling
logic. By requiring all five fields, the engine guarantees that adapters receive
a complete, unambiguous policy they can apply directly to harness tool
allow/deny/prompt mechanisms.

---

## `DEFAULT_PERMISSION`

```ts
const DEFAULT_PERMISSION: ToolPermission = "ask";
```

`DEFAULT_PERMISSION` is the fallback permission applied to any capability not
explicitly declared in an agent or category `tool_policy` block.

**Value: `"ask"`** — requires explicit user approval before the harness grants
the capability. This is the safest default: it never silently allows or denies
a capability the user did not configure. It must not be changed without an
approved spec update (see
[Spec 08](specs/08-spec-abstract-tool-policy-evaluation/08-spec-abstract-tool-policy-evaluation.md)).

---

## `evaluateEffectiveToolPolicy`

```ts
function evaluateEffectiveToolPolicy(
  policy: ToolPolicy | undefined,
): EffectiveToolPolicy
```

Resolves a raw (possibly partial or `undefined`) `ToolPolicy` into a fully
populated `EffectiveToolPolicy`.

**Rules:**

- If `policy` is `undefined`, every capability defaults to `DEFAULT_PERMISSION` (`"ask"`).
- For each capability, the configured value is preserved when present; otherwise
  `DEFAULT_PERMISSION` is applied.

**Properties:**

- **Pure and deterministic** — no side effects, no I/O, no adapter calls, no
  harness-specific knowledge.
- **Never throws** — safe to call in any context.

**Examples:**

```ts
// No policy declared → all capabilities default to "ask"
evaluateEffectiveToolPolicy(undefined);
// → { read: "ask", write: "ask", execute: "ask", delegate: "ask", network: "ask" }

// Partial policy → declared values preserved, missing ones default to "ask"
evaluateEffectiveToolPolicy({ read: "allow", write: "allow" });
// → { read: "allow", write: "allow", execute: "ask", delegate: "ask", network: "ask" }

// Full policy → all values preserved as-is
evaluateEffectiveToolPolicy({
  read: "allow", write: "allow", execute: "deny", delegate: "deny", network: "ask"
});
// → { read: "allow", write: "allow", execute: "deny", delegate: "deny", network: "ask" }
```

---

## `RunAgentEffect`

```ts
type RunAgentEffect = {
  readonly kind: "run-agent";
  readonly agentName: string;
  readonly agentDescriptor: AgentDescriptor;
  readonly effectiveToolPolicy: EffectiveToolPolicy;
  readonly rawToolPolicy: ToolPolicy | undefined;
};
```

`RunAgentEffect` is an observable effect emitted by the engine once per agent
during the adapter bootstrap loop, immediately before `adapter.spawnSubagent`
is called.

**When it is emitted:** For every non-disabled agent (including generated
`shuttle-{category}` agents), the engine composes an `AgentDescriptor` via
`composeAgentDescriptor` (which internally calls `evaluateEffectiveToolPolicy`)
and emits a `RunAgentEffect` via the optional `onEffect` callback supplied to
the bootstrap entry point (see [Adapter Bootstrap Guide](adapter-bootstrap.md)).

**Fields:**

| Field                  | Description                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                 | Always `"run-agent"`. Discriminant for future union variants.                                                                                               |
| `agentName`            | Logical agent name (key from `WeaveConfig.agents` or a generated `shuttle-{category}` name).                                                                |
| `agentDescriptor`      | The fully composed `AgentDescriptor` passed to the adapter. Contains `composedPrompt`, `delegationTargets`, `effectiveToolPolicy`, `rawToolPolicy`, etc.     |
| `effectiveToolPolicy`  | Fully-resolved policy computed by `evaluateEffectiveToolPolicy`. All five capabilities are present; missing declarations default to `DEFAULT_PERMISSION`.    |
| `rawToolPolicy`        | The raw `tool_policy` from the agent's config, or `undefined` when no `tool_policy` block was declared. Passed through to the adapter unchanged.            |

**`rawToolPolicy` purpose:** Adapters receive the raw policy via the
`AgentDescriptor` passed to `spawnSubagent` so they can apply harness-specific
translation — for example, mapping abstract capabilities to concrete tool names.
The engine never modifies the raw policy before passing it to the adapter.

---

## Adapter Contract

The adapter contract for tool policy is:

1. **Adapters receive the composed `AgentDescriptor`.** The runner passes a
   fully-composed descriptor (including `rawToolPolicy` and `effectiveToolPolicy`)
   to `adapter.spawnSubagent(descriptor)`. The descriptor carries both the raw
   declared policy and the engine-computed effective policy.

2. **Effective policy is engine-computed.** The engine computes
   `effectiveToolPolicy` during descriptor composition via
   `evaluateEffectiveToolPolicy(agentConfig.tool_policy)`. Adapters can read it
   directly from the descriptor or from the `RunAgentEffect` emitted via `onEffect`.

3. **No harness tool names in engine code.** The engine never hard-codes or
   branches on concrete harness tool identifiers (e.g. `bash`, `computer`,
   `str_replace_editor`). Adapters own the mapping from abstract capabilities to
   concrete tool names. See
   [Spec 07 — Adapter Capability Contract](specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md)
   for the `tool-policy-mapping` capability and `ConcreteToolClassification` /
   `resolveToolDecisions` APIs.

4. **Category shuttle agents.** Generated `shuttle-{category}` agents inherit
   their category's `tool_policy`. The runner evaluates and emits effective policy
   for them the same way as regular agents.

---

## Usage Example

The `onEffect` callback is supplied to the adapter bootstrap entry point. See
[Adapter Bootstrap Guide](adapter-bootstrap.md) for the full bootstrap pattern.

```ts
import { materializeAgents } from "@weave/engine";
import type { RunAgentEffect } from "@weave/engine";

// onEffect is an optional callback passed alongside materializeAgents
// (exact wiring depends on your adapter bootstrap — see adapter-bootstrap.md)
function handleEffect(effect: RunAgentEffect) {
  if (effect.kind === "run-agent") {
    // effectiveToolPolicy has all five capabilities resolved
    const { read, write, execute, delegate, network } =
      effect.effectiveToolPolicy;

    // rawToolPolicy is the original declared policy (may be undefined)
    const raw = effect.rawToolPolicy;

    myTelemetry.record({
      agent: effect.agentName,
      policy: { read, write, execute, delegate, network },
      hasDeclaredPolicy: raw !== undefined,
    });
  }
}
```

---

## Source Files

| File                                                                                    | Contents                                                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`packages/engine/src/tool-policy.ts`](../packages/engine/src/tool-policy.ts)           | `ABSTRACT_CAPABILITIES`, `EffectiveToolPolicy`, `DEFAULT_PERMISSION`, `evaluateEffectiveToolPolicy`, `resolveToolDecisions` |
| [`packages/engine/src/run-agent-effects.ts`](../packages/engine/src/run-agent-effects.ts) | `RunAgentEffect` discriminated union                                     |
| [`packages/engine/src/materialization.ts`](../packages/engine/src/materialization.ts)   | `materializeAgents`, `MaterializationPlan`, `MaterializedAgent`          |
| [`packages/engine/src/__tests__/tool-policy.test.ts`](../packages/engine/src/__tests__/tool-policy.test.ts) | Unit tests for `evaluateEffectiveToolPolicy` and `resolveToolDecisions`  |
| [`packages/engine/src/__tests__/materialization.test.ts`](../packages/engine/src/__tests__/materialization.test.ts) | Integration tests for `materializeAgents` including tool policy and category shuttle policy |
