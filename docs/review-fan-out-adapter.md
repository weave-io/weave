# Review Fan-Out Adapter Contract

This document describes the contract between the Weave engine and harness adapters for multi-model review fan-out. It covers the engine/adapter ownership split, the `spawnReviewVariants` method, fail-closed gate semantics, capability reporting, and the OpenCode adapter's specific implementation.

Related: [`docs/adapter-boundary.md`](adapter-boundary.md) (ownership matrix and anti-patterns), [`packages/engine/src/review-orchestration.ts`](../packages/engine/src/review-orchestration.ts) (engine types), [`packages/engine/src/adapter.ts`](../packages/engine/src/adapter.ts) (interface definition).

---

## Purpose

When a reviewer agent declares `review_models`, any invocation of that agent -- direct user request, Loom delegation, or workflow gate step -- triggers adversarial multi-model review. The adapter fans out the review prompt to each nominated model in parallel, collects their verdicts, and merges the results before the invocation resolves.

The primary entry point for direct (non-workflow) invocations is `executeDirectReview` ([`packages/adapters/opencode/src/direct-review.ts`](../packages/adapters/opencode/src/direct-review.ts)), which calls `ReviewOrchestrator.fanOut` directly (bypassing `ReviewFanOutIntent`) and returns a `DirectReviewResult` containing a `formattedSummary`. Workflow gate steps with `completion review_verdict` are a secondary consumer that reuses the same fan-out and collation machinery via the `reviewFanOutIntent` engine effect.

Fan-out is declared in the `.weave` DSL via `review_models` on the agent block. For workflow gate steps, the engine emits a `ReviewFanOutIntent` and delegates all harness execution to the adapter. For direct invocations, the OpenCode adapter's `chat.message` hook calls `ReviewOrchestrator.fanOut` directly without an engine effect.

---

## Engine Responsibilities

The engine owns the pure, harness-agnostic parts of fan-out:

| Responsibility | API surface |
| --- | --- |
| Emit `reviewFanOutIntent` on `RunAgentEffect` when `review_models` is declared | `packages/engine/src/run-agent-effects.ts` |
| Derive `ReviewVariantDescriptor[]` from config | `ReviewOrchestrator.fanOut(agentName)` |
| Fold per-variant results into `CollatedReview` and surface warnings | `ReviewOrchestrator.collate(results)` |
| Define all shared types: `ReviewVariantDescriptor`, `ReviewExecutionResult`, `CollatedReview`, error variants | `packages/engine/src/review-orchestration.ts` |

The engine never queries harness model registries, spawns harness sessions, or sets execution timeouts. All of those are adapter concerns.

---

## Adapter Responsibilities

Adapters own everything that touches a real harness:

| Responsibility | Notes |
| --- | --- |
| Implement `spawnReviewVariants` | Optional method on `HarnessAdapter`; omit to declare the capability unsupported |
| Filter variants against the harness model registry | Availability lookup is harness-specific |
| Execute variants in parallel via harness session APIs | Concurrency strategy (Promise.allSettled, worker pools, etc.) is adapter-chosen |
| Capture per-variant output | Output format and capture mechanism are harness-specific |
| Apply per-variant timeouts | Timeout policy depends on harness scheduling and infrastructure |
| Call `ReviewOrchestrator.collate(results)` | Adapter triggers the engine fold and translates `CollatedReview` to a completion signal |
| Report capability via `reviewFanOutCapability` | See Capability Reporting below |
| Best-effort session cleanup on completion or failure | Harness sessions should be deleted even when a variant fails |

---

## Runtime Wiring

This section describes the end-to-end execution path from step prompt rendering through fan-out to gate verdict.

### Method Signature

```ts
spawnReviewVariants?(
  variants: ReviewVariantDescriptor[],
  renderedPrompt?: string,
): ResultAsync<ReviewExecutionResult[], ReviewFanOutAdapterError>;
```

The method is optional. Callers must check `adapter.spawnReviewVariants != null` before invoking it. When absent, the caller degrades gracefully (falls back to single-model review or skips fan-out). `renderedPrompt` carries the fully rendered review prompt; adapters pass this directly to each variant session. For the workflow gate path, the prompt is forwarded from `DispatchAgentEffect.renderedPrompt`. For direct invocations, the caller passes the source text extracted from the hook input.

### Correct Data Flow

**Direct invocation (primary path):**

```text
executeDirectReview(agentName, prompt, adapter)
  -> ReviewOrchestrator.fanOut(agentName)            [pure engine plan]
  -> adapter.spawnReviewVariants(variants, prompt)   [adapter executes in harness]
       each variant: spawn session, send prompt, collect output, apply timeout
  -> ReviewOrchestrator.collate(results)             [pure engine fold]
  -> DirectReviewResult { formattedSummary, ... }
```

**Workflow gate step (secondary consumer):**

```text
renderStepPrompt
  -> DispatchAgentEffect.renderedPrompt (populated by engine)
  -> workflowRunner calls projectEffect(effect, renderedPrompt)
  -> buildProjectEffect detects reviewFanOutIntent (non-null)
  -> ReviewOrchestrator.fanOut(agentName)            [pure engine plan]
  -> adapter.spawnReviewVariants(variants, prompt)   [adapter executes in harness]
       each variant: spawn session, send prompt, collect output, apply timeout
  -> ReviewOrchestrator.collate(results)             [pure engine fold]
  -> translateReviewOutcome(collatedReview)          [ok = gate passes; err = gate blocks]
```

### Prompt Propagation Security Model

The rendered prompt text lives on `DispatchAgentEffect` (adapter transport). It is never stored on `RunAgentEffect` (the serializable engine record). This keeps the serializable effect boundary clean: `RunAgentEffect` carries only intent metadata (`reviewFanOutIntent`, agent name, model list). Raw prompt content travels only through the adapter invocation path and is never persisted to the effect log.

---

## Fail-Closed Gate Semantics

Gate steps that use review fan-out apply strict fail-closed semantics. The gate passes **only** when every variant produces an unambiguous `[APPROVE]` verdict. Any deviation blocks.

Specific rules:

- **Any REJECT or BLOCK verdict blocks the gate**, even if other variants returned APPROVE.
- **Any variant execution failure** (session spawn error, timeout, unrecognised output) is treated as a blocking condition. The gate does not pass on partial success.
- **Malformed output** (output that does not contain exactly one recognised verdict signal, or contains multiple conflicting signals) is treated as a blocking condition.
- **Multiple verdict signals** in a single variant's output produce a `malformed` verdict — ambiguous output is not safe to interpret and therefore blocks.
- `ReviewOrchestrator.collate` returns `err(CollatedReviewAllFailedError)` when every variant fails. Adapters must propagate this as a gate block.
- A `PartialFailureWarning` in `CollatedReview.warnings` means at least one variant failed but others succeeded. The gate still blocks; a failed review cannot be treated as an approval.
- An empty variant list (e.g. because `reviewModels` resolved to zero entries) blocks the gate.
- Missing adapter support (`spawnReviewVariants` absent) blocks the gate.
- Only a deliberate `[APPROVE]` verdict from **all** variants allows the gate to pass.

Fatal infrastructure errors that prevent any variant from being attempted return `err({ type: "ReviewFanOutSpawnError", ... })` from `spawnReviewVariants`. The caller must treat this as a gate block.

### Partial Failure Contract

When some variants succeed and some fail, `spawnReviewVariants` must return `ok(results)` with failed variants carrying `success: false` and an `errorMessage`. It must not return `err(...)` for partial failures. The engine's `collate` step then surfaces warnings and applies gate semantics.

| Scenario | `spawnReviewVariants` return | Gate outcome |
| --- | --- | --- |
| All variants `[APPROVE]` | `ok(results)` all `success: true`, all APPROVE | Pass |
| Any variant `[REJECT]` or `[BLOCK]` | `ok(results)` with at least one blocking verdict | Block |
| Any variant output malformed (no signal or multiple signals) | `ok(results)` with malformed verdict | Block |
| Some variants fail execution (partial) | `ok(results)` with failed variants `success: false` | Block |
| All variants fail execution | `ok(results)` all `success: false` | Block (collate returns `AllFailedError`) |
| Fatal infrastructure error | `err(ReviewFanOutSpawnError)` | Block |
| Missing adapter support | `spawnReviewVariants` absent | Block |
| Empty variant list | `ok([])` | Block (collate returns `AllFailedError`) |

---

## Capability Reporting

Adapters report their review fan-out support level via a `reviewFanOutCapability` property (or equivalent capability method) on the adapter instance. Three levels are defined:

| Level | Meaning |
| --- | --- |
| `native` | Adapter fully implements `spawnReviewVariants` with parallel session execution |
| `degraded` | Adapter implements `spawnReviewVariants` but with reduced capability (e.g., sequential execution, limited model support) |
| `unsupported` | Adapter does not implement `spawnReviewVariants`; callers skip fan-out |

Capability is checked before fan-out is attempted. When capability is `unsupported`, the caller falls back to single-model review and logs a warning. When capability is `degraded`, fan-out proceeds with reduced guarantees and any limitations are surfaced as warnings in the collated output.

---

## OpenCode Adapter Specifics

The OpenCode adapter (`packages/adapters/opencode/src/`) implements `spawnReviewVariants` using OpenCode session APIs.

### Session Lifecycle

Each variant is executed in an isolated OpenCode session:

1. `session.create(variantConfig)` creates a session configured for the variant's review model.
2. `session.prompt(sessionId, variantPrompt)` sends the review prompt and waits for output.
3. `session.delete(sessionId)` cleans up the session (best-effort, runs even on failure).

Sessions are created and prompted in parallel via `Promise.allSettled`. This means all variants start concurrently; a failure in one variant does not cancel others.

### Parallel Execution

```ts
// Adapter pattern: parallel via Promise.allSettled, best-effort cleanup
async spawnReviewVariants(variants) {
  const available = await this.getAvailableModels();
  const eligible = variants.filter(v => available.includes(v.reviewModel));
  const results = await Promise.allSettled(
    eligible.map(v => this.executeVariantWithCleanup(v))
  );
  return ok(results.map(toReviewExecutionResult));
}
```

`Promise.allSettled` is used (not `Promise.all`) so that one variant's failure does not abort the others. Each variant's session is deleted in a `finally` block inside `executeVariantWithCleanup`.

### Output Capture

The adapter captures the session's final assistant message as the variant's raw output. Verdict extraction (APPROVE/REJECT/BLOCK) is done by the engine's collate step from the structured output, not by the adapter.

### Model Availability

Before spawning sessions, the adapter filters `variants` against the harness model registry. Variants whose `reviewModel` is not available in the current OpenCode session are returned as `success: false` with an `errorMessage` explaining availability.

### Capability Declaration

The OpenCode adapter reports capability `native` when session APIs are available, `degraded` when running in a constrained environment (e.g., no parallel session support), and `unsupported` when session APIs are unavailable.

---

## Verdict Parsing and Gate Policy

After `spawnReviewVariants` returns, the adapter calls `translateReviewOutcome` to map the collation result to a gate pass or block. This function uses `gateDecision.passed` from `CollatedReview` to determine the outcome.

Verdict parsing and gate policy are defined in the engine:

- **`parseVerdict`** ([`packages/engine/src/review-verdict-parser.ts`](../packages/engine/src/review-verdict-parser.ts)) - extracts a `ReviewVerdict` from raw agent output. Recognised signals: `[APPROVE]`, `[REJECT]`, `[BLOCK]` (case-insensitive, bracket form only). First match wins; no match produces `malformed`.
- **`evaluateGateDecision`** ([`packages/engine/src/review-gate-policy.ts`](../packages/engine/src/review-gate-policy.ts)) - applies v1 strict policy: all variants must approve for the gate to pass. Any `reject`, `block`, `malformed`, execution failure, or empty variant list blocks the gate.

See [Spec 32 - Verdict Semantics](specs/32-spec-review-models/32-spec-review-models.md#6a-verdict-semantics) for the full decision table and `ReviewVerdict` type definition.

---

## Boundary Rules

These rules enforce that no harness-specific code enters the engine:

- The engine must not import any OpenCode session types, client libraries, or harness-specific APIs.
- The engine must not decide concurrency strategy, timeouts, or execution ordering.
- The engine must not query model availability from any harness registry.
- All OpenCode session semantics (create/prompt/delete lifecycle, parallel strategy, output capture) live exclusively in the adapter package.
- Engine APIs (`fanOut`, `collate`) accept explicit inputs and return normalized results. They do not reach into adapter state.

See [`docs/adapter-boundary.md`](adapter-boundary.md) for the full ownership matrix and anti-pattern examples.
