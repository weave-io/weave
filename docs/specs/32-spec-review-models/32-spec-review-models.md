# Spec 32: Review Models

**Status**: Active
**Related DSL field**: [`review_models`](../../dsl-reference.md#review-models)
**Related source files**:
- [`packages/core/src/schema.ts`](../../../packages/core/src/schema.ts): Zod schema for `review_models`
- [`packages/engine/src/review-variants.ts`](../../../packages/engine/src/review-variants.ts): `generateReviewVariants`
- [`packages/engine/src/execution-lifecycle/dispatch.ts`](../../../packages/engine/src/execution-lifecycle/dispatch.ts): effect dispatch emission for review routing
- [`packages/engine/src/review-orchestration.ts`](../../../packages/engine/src/review-orchestration.ts): review variant routing support
**Related specs**:
- [Spec 16: Stable Adapter Descriptor Contract](../16-spec-stable-adapter-descriptor-contract/16-spec-stable-adapter-descriptor-contract.md)
- [Spec 22: Workflow-First Execution](../22-spec-workflow-first-execution/22-spec-workflow-first-execution.md)
- [Adapter Boundary](../../adapter-boundary.md)

---

## 1. Purpose

`review_models` lets an agent declaration nominate one or more alternative models that are materialized as independent reviewer variants whenever config is loaded or composed. The engine's prompt-composed routing layer instructs Loom/Tapestry to route review requests to the base reviewer plus each materialized variant through normal delegation — the same mechanism used for any other multi-agent step. Review variants are not gate-scoped: they are available to any orchestrator prompt that chooses to invoke them.

This spec defines:

- Syntax and validation rules for the `review_models` field
- Review variant naming and descriptor generation
- Review variant routing via prompt-composed delegation to Loom/Tapestry
- Partial-failure policy
- Builtin agent defaults and cost-protection rationale

---

## 2. Syntax

### 2.1 Field Declaration

`review_models` is an optional field on any `agent` block. It accepts a non-empty array of model identifier strings.

```weave
agent warp {
  description "Warp (Security Reviewer)"
  prompt_file "warp.md"
  models ["claude-sonnet-4-5"]
  mode subagent

  review_models ["openai/gpt-4o", "anthropic/claude-opus-4-5"]
}
```

### 2.2 Constraints

| Constraint | Rule |
| --- | --- |
| Type | Non-empty string array (`string[]`, length >= 1) |
| Mutual exclusivity | None. `review_models` may coexist with `models`. |
| Scope | Agent blocks only. Category-level `review_models` is out of scope for v1 and is not processed. |
| Omission | If omitted, no review variants are generated and no fan-out occurs. |
| Empty array | Rejected at validation time with a typed `ValidationError`. |

---

## 3. Review Variant Generation

When `generateReviewVariants` processes an agent descriptor that carries `review_models`, it creates one read-only subagent descriptor per entry in the array.

### 3.1 Naming Convention

```
{agentName}-{sanitizedModel}
```

`sanitizedModel` is the model identifier with every `/` character replaced by `-`.

**Examples:**

| Agent name | `review_models` entry | Generated variant name |
| --- | --- | --- |
| `warp` | `"openai/gpt-4o"` | `warp-openai-gpt-4o` |
| `warp` | `"anthropic/claude-opus-4-5"` | `warp-anthropic-claude-opus-4-5` |
| `weft` | `"claude-sonnet-4-5"` | `weft-claude-sonnet-4-5` |

### 3.2 Variant Descriptor Shape

Each generated variant inherits from the base agent descriptor with the following overrides:

| Field | Value |
| --- | --- |
| `name` | `{agentName}-{sanitizedModel}` |
| `models` | `[reviewModel]` (exactly one entry, the nominated review model) |
| `tool_policy.write` | `deny` (review variants are read-only) |
| `tool_policy.execute` | `deny` |
| `tool_policy.delegate` | `deny` |
| `tool_policy.network` | `deny` |
| `mode` | `subagent` |
| `review_models` | `undefined` (stripped to prevent recursive fan-out) |

All other fields (`prompt`, `prompt_file`, `prompt_append`, `temperature`, `tool_policy.read`) are inherited from the base agent unchanged.

---

## 4. Review Routing

### 4.1 Activation Condition

Review variant routing is available whenever a Loom or Tapestry prompt is composed with materialized review variants in its delegation targets. It is not limited to `gate` workflow steps or `review_verdict` completion methods.

Concretely, routing activates when:

1. An agent has at least one entry in `review_models`, and
2. Loom or Tapestry receives prompt instructions that include the materialized variant agents as delegation targets.

The presence of `review_models` on an agent causes variant agents to be materialized and registered at startup (see Section 3). Whether and when those variants are invoked is determined by the prompt instructions composed for Loom/Tapestry — not by the workflow step type or completion method.

If an agent has no `review_models` entries, no variants are materialized and Loom/Tapestry delegates to the base agent only.

### 4.2 Design: Materialized Agents and Prompt-Composed Routing

Review variants are **materialized as first-class agent descriptors** (see Section 3) and registered in the engine's agent registry at startup, exactly like any other agent. There is no special fan-out effect type and no adapter-owned execution path.

The engine's **prompt-composed routing layer** instructs Loom/Tapestry to delegate execution to the base reviewer agent plus each materialized variant agent. Loom/Tapestry orchestrates the parallel or sequential calls as normal subagent delegation — the same mechanism used for any other multi-agent step.

**Adapters are dumb with respect to review variants.** Adapters do not:

- detect or interpret review variant names
- own fan-out execution or variant scheduling
- collate variant results
- translate collated results into `review_verdict` signals

Adapters execute single agent calls as directed by the orchestrator. All routing, scheduling, collation, and verdict resolution are engine-owned.

### 4.3 Scope Note

Runtime collation of variant result records and workflow lifecycle completion (e.g. `completeStep`, verdict transitions) are **not wired in this PR**. This spec covers materialized agent generation and prompt-composed routing instructions for Loom/Tapestry. End-to-end collation and verdict resolution remain out of scope for vNext and will be addressed in a future spec.

---

## 5. Partial-Failure Policy

> **Note:** The following policy describes intended future behavior for when runtime collation is wired. In this PR, Loom/Tapestry are instructed via prompt composition to run the base reviewer plus all generated variant agents through normal delegation. Collation of results and lifecycle completion are not implemented in this PR.

Because review variants are materialized agents delegated through Loom/Tapestry like any other subagent, the orchestrator receives one result record per variant. The intended routing policy is:

### 5.1 Outcome Resolution

| Condition | Intended outcome |
| --- | --- |
| All variants succeed | Step completes with combined successful results; no warnings |
| At least one variant succeeds, rest fail | Step completes with successful results; failed variants are logged as warnings |
| All variants fail (error or timeout) | Step fails; failures are listed with variant name, model, and error message |

### 5.2 Partial Failure

When one or more variants fail but at least one succeeds:

- The orchestrator combines the output of the successful variants only.
- Failures are logged; the step is treated as a normal completion.
- The step is NOT retried automatically.

The intent is that a single model outage does not block the entire review gate when sufficient reviewers remain.

### 5.3 All-Variants-Failed

When every variant fails:

- The step is treated as failed and lists every failed variant with its name, model, and error.
- No automatic fallback to the base agent occurs.
- Adapters are not involved in failure translation.

> These outcomes are not enforced at runtime in this PR. Loom/Tapestry handle delegation outcomes through their normal subagent result paths.

---

## 6. Builtin Agent Defaults

Builtin agents (`loom`, `shuttle`, `warp`, `weft`, `pattern`, `spindle`) intentionally omit `review_models` in their default DSL declarations.

**Rationale**: Review fan-out incurs additional model invocations and thus additional cost. Defaulting to no `review_models` means users opt in explicitly, rather than incurring unexpected cost from a builtin default.

Users can add `review_models` to any builtin agent by declaring an override in their project or global `.weave/config.weave`:

```weave
agent warp {
  review_models ["openai/gpt-4o"]
}
```

The override is merged with the builtin declaration; other fields are preserved.

---

## 7. Acceptance Criteria

| # | Criterion |
| --- | --- |
| AC-1 | `review_models` parses as a non-empty string array on any `agent` block |
| AC-2 | An empty `review_models []` is rejected at validation time |
| AC-3 | `review_models` is honored only on `agent` blocks; category-level review models are out of scope for v1 |
| AC-4 | `generateReviewVariants` produces one descriptor per entry, named `{agentName}-{sanitizedModel}` |
| AC-5 | Generated variant descriptors have `write deny`, `execute deny`, `delegate deny`, and `models: [reviewModel]` |
| AC-6 | Review variant routing is available when Loom/Tapestry prompts are composed with review variants in delegation targets; routing is not limited to `gate` steps and is driven by prompt composition, not workflow gate activation |
| AC-7 | Adapters execute single agent calls as directed; they do not own fan-out, result collation, or verdict translation |
| AC-8 | When all variants succeed, the engine combines their outputs with no warnings |
| AC-9 | When at least one variant fails but at least one succeeds, the step completes with a warning logged for each failure |
| AC-10 | When all variants fail, the engine fails the step and lists every failed variant with its name, model, and error |
| AC-11 | Builtin agents do not declare `review_models` in their default DSL |
