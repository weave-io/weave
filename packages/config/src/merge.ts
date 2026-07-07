import {
  type WeaveConfig,
  WeaveConfigSchema,
  type WorkflowConfig,
  type WorkflowStep,
} from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";

// ---------------------------------------------------------------------------
// WorkflowExtensionError — discriminated union
// ---------------------------------------------------------------------------

/**
 * Errors that can occur during workflow extension / step-aware merge.
 *
 * - `UnknownExtendsTarget`    — `extends` names a workflow that does not exist
 *                               in the workflow map being merged
 * - `UnknownInsertionAnchor`  — `insert_before` / `insert_after` names a step
 *                               that does not exist in the resolved base steps
 * - `BothInsertBeforeAndAfter`— a step declares both `insert_before` and
 *                               `insert_after` (schema-level guard, but also
 *                               caught here for defence-in-depth)
 * - `ExtendsCycle`            — the `extends` chain contains a cycle
 */
export type WorkflowExtensionError =
  | {
      type: "UnknownExtendsTarget";
      workflowName: string;
      extendsTarget: string;
    }
  | {
      type: "UnknownInsertionAnchor";
      workflowName: string;
      stepName: string;
      anchor: string;
    }
  | {
      type: "BothInsertBeforeAndAfter";
      workflowName: string;
      stepName: string;
    }
  | {
      type: "ExtendsCycle";
      workflowName: string;
      cycle: string[];
    };

// ---------------------------------------------------------------------------
// MergeError — wraps WorkflowExtensionError entries
// ---------------------------------------------------------------------------

/**
 * Top-level merge error type. Currently wraps `WorkflowExtensionError`
 * entries produced during step-aware workflow merging.
 */
export type MergeError = {
  type: "WorkflowExtensionError";
  error: WorkflowExtensionError;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively merges two values following the Weave merge rules:
 *
 * - `undefined` override → keep base value
 * - Both are non-null plain objects (not arrays) → deep-merge each key
 * - Both are arrays → union-merge: override entries first, then base entries
 *   not already present (strings compared with `===`; objects compared with
 *   `JSON.stringify` equality)
 * - Anything else (scalar, `null`, mismatched types) → override wins
 *
 * Inputs are never mutated.
 *
 * NOTE: WorkflowConfig values inside the `workflows` record are handled
 * specially by `mergeWorkflowRecord` before this function is called for
 * the top-level config object. This function therefore treats workflow
 * objects as plain objects (deep-merge) for any residual path that does
 * not go through the special handler.
 */
function mergeValues(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;

  if (Array.isArray(base) && Array.isArray(override)) {
    // Union-merge: override entries first, then base entries not already present.
    const seen = new Set<string>();
    const result: unknown[] = [];

    for (const item of override) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }

    for (const item of base) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }

    return result;
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      merged[key] = mergeValues(
        (base as Record<string, unknown>)[key],
        (override as Record<string, unknown>)[key],
      );
    }
    return merged;
  }

  // Scalar or null: override wins.
  return override;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Workflow step-aware merge
// ---------------------------------------------------------------------------

/**
 * Resolve the `extends` chain for a workflow, returning the ordered list of
 * base steps. Detects cycles by tracking visited names.
 *
 * When `extendsTarget === workflowName`, the base steps are taken directly
 * from `baseSteps` (the lower-priority layer's steps) rather than looking up
 * the workflow map — this is the normal "project extends builtin" pattern.
 *
 * @param workflowName  - Name of the workflow being resolved (for error context)
 * @param extendsTarget - The `extends` value on the override workflow
 * @param baseSteps     - The steps from the lower-priority (base) layer
 * @param workflowMap   - The merged workflow map to look up other base workflows in
 * @returns `ok(WorkflowStep[])` with the base steps, or `err(WorkflowExtensionError)`
 */
function resolveBaseSteps(
  workflowName: string,
  extendsTarget: string,
  baseSteps: WorkflowStep[],
  workflowMap: Record<string, WorkflowConfig>,
): Result<WorkflowStep[], WorkflowExtensionError> {
  // Self-reference: use the base steps directly (normal "project extends builtin" pattern)
  if (extendsTarget === workflowName) {
    return ok(baseSteps);
  }

  const visited = new Set<string>([workflowName]);
  let current = extendsTarget;

  while (true) {
    if (visited.has(current)) {
      return err({
        type: "ExtendsCycle",
        workflowName,
        cycle: [...visited, current],
      });
    }

    const target = workflowMap[current];
    if (target === undefined) {
      return err({
        type: "UnknownExtendsTarget",
        workflowName,
        extendsTarget: current,
      });
    }

    visited.add(current);

    // If the target itself extends another, follow the chain
    if (target.extends !== undefined) {
      current = target.extends;
      continue;
    }

    // Reached a concrete base — return its steps
    return ok(target.steps);
  }
}

/**
 * Merge an override `WorkflowConfig` onto a base `WorkflowConfig` using
 * step-aware semantics:
 *
 * 1. Resolve the effective base steps (via `extends` chain or the base workflow's
 *    own steps).
 * 2. Same-name replacement: override steps whose `name` matches a base step
 *    replace the base step in place.
 * 3. Anchored insertion: remaining override steps with `insert_before` /
 *    `insert_after` are inserted at the resolved index.
 * 4. Append: remaining override steps with no anchor and no same-name match
 *    are appended.
 * 5. Return the merged `WorkflowConfig`.
 *
 * @param workflowName - The key name of the workflow (for error context)
 * @param base         - The base workflow (from the lower-priority config layer)
 * @param override     - The override workflow (from the higher-priority config layer)
 * @param workflowMap  - The full merged workflow map (used to resolve `extends`)
 */
export function mergeWorkflow(
  workflowName: string,
  base: WorkflowConfig,
  override: WorkflowConfig,
  workflowMap: Record<string, WorkflowConfig>,
): Result<WorkflowConfig, WorkflowExtensionError> {
  // If the override does not use `extends`, fall back to plain deep-merge
  // (backwards-compat: existing configs without `extends` keep union-merge
  // semantics for the steps array via the generic mergeValues path).
  if (override.extends === undefined) {
    return ok(mergeValues(base, override) as WorkflowConfig);
  }

  // Resolve base steps from the extends chain.
  // When override.extends === workflowName, resolveBaseSteps uses base.steps
  // directly (the "project extends builtin" pattern — not a cycle).
  const baseStepsResult = resolveBaseSteps(
    workflowName,
    override.extends,
    base.steps,
    workflowMap,
  );
  if (baseStepsResult.isErr()) return err(baseStepsResult.error);

  const baseSteps: WorkflowStep[] = baseStepsResult.value.map((s) => ({
    ...s,
  }));

  // Partition override steps into three buckets:
  // 1. same-name replacements
  // 2. anchored insertions
  // 3. appends
  const baseStepNames = new Set(baseSteps.map((s) => s.name));
  const replacements: WorkflowStep[] = [];
  const anchored: WorkflowStep[] = [];
  const appends: WorkflowStep[] = [];

  for (const step of override.steps) {
    if (baseStepNames.has(step.name)) {
      replacements.push(step);
    } else if (
      step.insert_before !== undefined ||
      step.insert_after !== undefined
    ) {
      anchored.push(step);
    } else {
      appends.push(step);
    }
  }

  // Step 2: Apply same-name replacements in place
  let workingSteps: WorkflowStep[] = baseSteps.map((baseStep) => {
    const replacement = replacements.find((r) => r.name === baseStep.name);
    return replacement !== undefined ? replacement : baseStep;
  });

  // Step 3: Apply anchored insertions
  for (const step of anchored) {
    if (step.insert_before !== undefined && step.insert_after !== undefined) {
      return err({
        type: "BothInsertBeforeAndAfter",
        workflowName,
        stepName: step.name,
      });
    }

    const anchor = step.insert_before ?? step.insert_after;
    const anchorIndex = workingSteps.findIndex((s) => s.name === anchor);

    if (anchorIndex === -1) {
      return err({
        type: "UnknownInsertionAnchor",
        workflowName,
        stepName: step.name,
        anchor: anchor as string,
      });
    }

    if (step.insert_before !== undefined) {
      workingSteps = [
        ...workingSteps.slice(0, anchorIndex),
        step,
        ...workingSteps.slice(anchorIndex),
      ];
    } else {
      // insert_after
      workingSteps = [
        ...workingSteps.slice(0, anchorIndex + 1),
        step,
        ...workingSteps.slice(anchorIndex + 1),
      ];
    }
  }

  // Step 4: Append remaining steps
  workingSteps = [...workingSteps, ...appends];

  // Build merged workflow: scalar fields from override win; steps from merge
  const merged: WorkflowConfig = {
    ...(mergeValues(base, {
      ...override,
      steps: workingSteps,
    }) as WorkflowConfig),
    steps: workingSteps,
  };

  return ok(merged);
}

/**
 * Merge two `workflows` records using step-aware merge for workflows that
 * appear in both records.
 *
 * @param baseWorkflows     - Workflows from the lower-priority config layer
 * @param overrideWorkflows - Workflows from the higher-priority config layer
 * @returns `ok(merged)` or `err(MergeError[])` if any workflow extension fails
 */
function mergeWorkflowRecord(
  baseWorkflows: Record<string, WorkflowConfig>,
  overrideWorkflows: Record<string, WorkflowConfig>,
): Result<Record<string, WorkflowConfig>, MergeError[]> {
  // Build the combined map: start with base, then apply overrides
  const combined: Record<string, WorkflowConfig> = { ...baseWorkflows };

  // First pass: add all override-only workflows (no base counterpart)
  for (const [name, overrideWf] of Object.entries(overrideWorkflows)) {
    if (baseWorkflows[name] === undefined) {
      combined[name] = overrideWf;
    }
  }

  const errors: MergeError[] = [];

  // Second pass: step-aware merge for workflows present in both
  for (const [name, overrideWf] of Object.entries(overrideWorkflows)) {
    const baseWf = baseWorkflows[name];
    if (baseWf === undefined) continue;

    const result = mergeWorkflow(name, baseWf, overrideWf, combined);
    if (result.isErr()) {
      errors.push({ type: "WorkflowExtensionError", error: result.error });
      continue;
    }
    combined[name] = result.value;
  }

  if (errors.length > 0) return err(errors);
  return ok(combined);
}

function deepMerge2Result(
  base: WeaveConfig,
  override: WeaveConfig,
): Result<WeaveConfig, MergeError[]> {
  // Handle workflows specially; merge everything else with generic mergeValues.
  //
  // before-plan ownership note:
  //   `extension_points` is a plain object field on WorkflowConfig — it passes
  //   through mergeWorkflowRecord → mergeWorkflow → mergeValues as a deep-merge,
  //   so `extension_points.before_plan` is preserved from whichever layer sets it.
  //
  //   `extend_before_plan` is a top-level WeaveConfig field — it passes through
  //   the generic mergeValues path below. Its `steps` arrays union-merge across
  //   layers (override entries first, then base entries not already present).
  //
  //   Both fields are engine-visible only after merge resolution completes.
  //   The engine is responsible for checking `extension_points.before_plan` on
  //   the target workflow before applying `extend_before_plan` entries — the
  //   merge layer does not enforce that cross-field constraint.
  const baseWorkflows = base.workflows ?? {};
  const overrideWorkflows = override.workflows ?? {};

  const workflowResult = mergeWorkflowRecord(baseWorkflows, overrideWorkflows);
  if (workflowResult.isErr()) return err(workflowResult.error);

  // Merge the rest of the config (excluding workflows which we handle above)
  const { workflows: _baseWf, ...baseRest } = base;
  const { workflows: _overrideWf, ...overrideRest } = override;
  const mergedRest = mergeValues(baseRest, overrideRest) as Omit<
    WeaveConfig,
    "workflows"
  >;

  return ok({ ...mergedRest, workflows: workflowResult.value });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge multiple `WeaveConfig` objects using left-fold semantics.
 * Returns a `Result` — callers should prefer this over `mergeConfigs`.
 *
 * Priority increases left to right — later configs override earlier ones.
 * Typical call order: `mergeConfigsResult(builtins, globalConfig, projectConfig)`.
 *
 * **Merge rules per value type:**
 * - *Scalars* (string, number, boolean, enum): last-defined wins
 * - *Objects* (e.g. `agents`, `tool_policy`): recursive deep-merge — only
 *   keys present in the override are updated; all other keys are preserved
 * - *Arrays* (e.g. `models`, `disabled.agents`): union-merge — override
 *   entries come first, then base entries not already present (deduped by
 *   `JSON.stringify` equality); order reflects priority (highest first)
 * - *Workflows*: step-aware merge — same-name replacement, anchored insertion,
 *   append; `extends` chain is resolved across the merged workflow map
 *
 * **before-plan extension surface:**
 * - `extension_points.before_plan` on a `WorkflowConfig` is preserved through
 *   workflow merge via generic deep-merge. The engine reads this field from the
 *   merged config to determine whether a workflow publishes the `before-plan` slot.
 * - `extend_before_plan` (top-level) is preserved via generic deep-merge; its
 *   `steps` arrays union-merge across layers. The engine reads this field from
 *   the merged config to determine which steps to inject into the slot.
 * - Both fields are engine-visible **only after** merge resolution completes.
 *   The engine is responsible for checking `extension_points.before_plan` before
 *   applying `extend_before_plan` entries — the merge layer does not enforce that
 *   cross-field constraint.
 *
 * **Immutability:** Input configs are never mutated.
 */
export function mergeConfigsResult(
  ...configs: WeaveConfig[]
): Result<WeaveConfig, MergeError[]> {
  if (configs.length === 0) {
    return ok(WeaveConfigSchema.parse({}));
  }
  if (configs.length === 1) {
    return ok(configs[0] as WeaveConfig);
  }

  let acc: WeaveConfig = configs[0] as WeaveConfig;
  for (let i = 1; i < configs.length; i++) {
    const next = configs[i] as WeaveConfig;
    const result = deepMerge2Result(acc, next);
    if (result.isErr()) return err(result.error);
    acc = result.value;
  }
  return ok(acc);
}

/**
 * Merge multiple `WeaveConfig` objects using left-fold semantics.
 *
 * Priority increases left to right — later configs override earlier ones.
 * Typical call order: `mergeConfigs(builtins, globalConfig, projectConfig)`.
 *
 * **Merge rules per value type:**
 * - *Scalars* (string, number, boolean, enum): last-defined wins
 * - *Objects* (e.g. `agents`, `tool_policy`): recursive deep-merge — only
 *   keys present in the override are updated; all other keys are preserved
 * - *Arrays* (e.g. `models`, `disabled.agents`): union-merge — override
 *   entries come first, then base entries not already present (deduped by
 *   `JSON.stringify` equality); order reflects priority (highest first)
 * - *Workflows*: step-aware merge — same-name replacement, anchored insertion,
 *   append; `extends` chain is resolved across the merged workflow map
 *
 * **Immutability:** Input configs are never mutated.
 *
 * @param configs - Zero or more configs to merge. If no configs are provided,
 *   returns the default (empty) `WeaveConfig`. If exactly one config is
 *   provided, returns it as-is.
 *
 * @deprecated Prefer `mergeConfigsResult` which returns `Result<WeaveConfig, MergeError[]>`
 *   and avoids throwing. This wrapper throws a `MergeError` aggregate on the first
 *   workflow extension failure.
 */
export function mergeConfigs(...configs: WeaveConfig[]): WeaveConfig {
  const result = mergeConfigsResult(...configs);
  if (result.isErr()) {
    const first = result.error[0];
    throw first;
  }
  return result.value;
}
