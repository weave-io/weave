# Spec 32: Review Models

**Status**: Active
**Related DSL field**: [`review_models`](../../dsl-reference.md#review-models)
**Related source files**:
- [`packages/core/src/schema.ts`](../../../packages/core/src/schema.ts): Zod schema for `review_models`
- [`packages/engine/src/review-variants.ts`](../../../packages/engine/src/review-variants.ts): `generateReviewVariants`
- [`packages/engine/src/run-agent-effects.ts`](../../../packages/engine/src/run-agent-effects.ts): `RunAgentEffect.reviewFanOutIntent` type; [`packages/engine/src/execution-lifecycle/dispatch.ts`](../../../packages/engine/src/execution-lifecycle/dispatch.ts): effect dispatch emission
- [`packages/engine/src/review-orchestration.ts`](../../../packages/engine/src/review-orchestration.ts): `ReviewOrchestrator.collate`
**Related specs**:
- [Spec 16: Stable Adapter Descriptor Contract](../16-spec-stable-adapter-descriptor-contract/16-spec-stable-adapter-descriptor-contract.md)
- [Spec 22: Workflow-First Execution](../22-spec-workflow-first-execution/22-spec-workflow-first-execution.md)
- [Adapter Boundary](../../adapter-boundary.md)

---

## 1. Purpose

`review_models` lets an agent declaration nominate one or more alternative models that serve as independent reviewers in a `gate` workflow step. When the workflow engine reaches a `gate` step with `completion review_verdict` and the assigned agent has `review_models` set, it fans out the review prompt to each model in parallel, collates the results, and resolves a single approve-or-reject verdict.

This spec defines:

- Syntax and validation rules for the `review_models` field
- Review variant naming and descriptor generation
- Fan-out intent emission and adapter contract
- Collation semantics and partial-failure policy
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
{agentName}-review-{sanitizedModel}
```

`sanitizedModel` is the model identifier with every `/` character replaced by `-`.

**Examples:**

| Agent name | `review_models` entry | Generated variant name |
| --- | --- | --- |
| `warp` | `"openai/gpt-4o"` | `warp-review-openai-gpt-4o` |
| `warp` | `"anthropic/claude-opus-4-5"` | `warp-review-anthropic-claude-opus-4-5` |
| `weft` | `"claude-sonnet-4-5"` | `weft-review-claude-sonnet-4-5` |

### 3.2 Variant Descriptor Shape

Each generated variant inherits from the base agent descriptor with the following overrides:

| Field | Value |
| --- | --- |
| `name` | `{agentName}-review-{sanitizedModel}` |
| `models` | `[reviewModel]` (exactly one entry, the nominated review model) |
| `tool_policy.write` | `deny` (review variants are read-only) |
| `tool_policy.execute` | `deny` |
| `tool_policy.delegate` | `deny` |
| `tool_policy.network` | `deny` |
| `mode` | `subagent` |
| `review_models` | `undefined` (stripped to prevent recursive fan-out) |

All other fields (`prompt`, `prompt_file`, `prompt_append`, `temperature`, `tool_policy.read`) are inherited from the base agent unchanged.

---

## 4. Fan-Out Intent

### 4.1 Emission Condition

The engine emits a `RunAgentEffect.reviewFanOutIntent` effect when all three conditions hold simultaneously:

1. The current workflow step has `type gate`
2. The step's `completion` method is `review_verdict`
3. The step's agent has at least one entry in `review_models`

If any condition is false, no fan-out occurs and the step executes with the base agent only.

### 4.2 Effect Shape

`reviewFanOutIntent` is a field on the `RunAgentEffect` record (see [`packages/engine/src/run-agent-effects.ts`](../../../packages/engine/src/run-agent-effects.ts)) with the following shape:

```ts
{
  agentName: string;      // logical name of the base agent (e.g. "weft")
  reviewModels: string[]; // review_models declared on the agent config
}
```

The adapter uses `agentName` to call `ReviewOrchestrator.fanOut(agentName)`, which derives the full set of variant descriptors. `reviewModels` is provided as a convenience so adapters do not need to re-read the config.

### 4.3 Adapter Contract

The `reviewFanOutIntent` effect is an intent signal, not a direct execution command. Adapters decide how to materialise parallel execution.

- Adapters that support concurrent subagent spawning MAY execute all variants in parallel.
- Adapters that do not support parallel execution MUST execute variants sequentially and still pass all results to `ReviewOrchestrator.collate`.
- Adapters MUST NOT suppress or discard individual variant results before collation, even if a variant returns an error.

See [Adapter Boundary](../../adapter-boundary.md) for the canonical ownership boundary between engine intent and adapter execution.

---

## 5. Collation Semantics

`ReviewOrchestrator.collate` receives one `ReviewExecutionResult` record per variant and returns either a `CollatedReview` (at least one variant succeeded) or `err(CollatedReviewAllFailedError)` (all variants failed). Adapters translate the returned value into a `review_verdict` completion signal and own any additional logging or presentation.

### 5.1 Outcome Resolution

| Condition | `collate` return value |
| --- | --- |
| All variants succeed | `ok(CollatedReview)` — `warnings` is empty |
| At least one variant succeeds, rest fail | `ok(CollatedReview)` — failed variants appear in `warnings` |
| All variants fail (error or timeout) | `err(CollatedReviewAllFailedError)` — `failures` lists every failed variant |

### 5.2 Partial Failure Policy

When one or more variants fail but at least one succeeds:

- `collate` returns `ok(CollatedReview)` with non-empty `warnings`.
- `CollatedReview.collatedOutput` contains the combined output of the successful variants only.
- The adapter is responsible for translating warnings into structured log entries or harness notifications; the engine does not log directly from `collate`.
- The step is NOT retried automatically. Retry policy is adapter-owned.

The intent is that a single model outage does not block the entire review gate when sufficient reviewers remain.

### 5.3 All-Variants-Failed Policy

When every variant fails:

- `collate` returns `err(CollatedReviewAllFailedError)`.
- `CollatedReviewAllFailedError.failures` lists every failed variant with its `variantName`, `reviewModel`, and `errorMessage`.
- Adapters translate this error into a `review_verdict` rejection signal and may emit structured log entries with the failure details.
- The workflow step transitions to the `on_reject` action (e.g. `pause`) via the normal `completeStep` path.
- No automatic fallback to the base agent occurs.

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
| AC-4 | `generateReviewVariants` produces one descriptor per entry, named `{agentName}-review-{sanitizedModel}` |
| AC-5 | Generated variant descriptors have `write deny`, `execute deny`, `delegate deny`, and `models: [reviewModel]` |
| AC-6 | `reviewFanOutIntent` is emitted only for `gate` steps with `completion review_verdict` on agents that have `review_models` |
| AC-7 | Adapters that cannot parallelize must still pass all results to collation |
| AC-8 | `collate` returns `approve` only when all successful variants approve |
| AC-9 | `collate` returns `reject` with a warning when at least one variant fails but at least one succeeds |
| AC-10 | `collate` returns `reject` with an error when all variants fail |
| AC-11 | Builtin agents do not declare `review_models` in their default DSL |
