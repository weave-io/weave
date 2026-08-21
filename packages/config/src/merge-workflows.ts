import {
  copySafeGraph,
  type ExtensionPoints,
  type SafeGraphObject,
  type SafeGraphValue,
  type WeaveConfig,
  type WorkflowConfig,
  WorkflowConfigSchema,
  type WorkflowStep,
} from "@weaveio/weave-core";
import { err, ok, Result } from "neverthrow";
import { WORKFLOW_GRAPH_COPY_BUDGET } from "./merge-budgets.js";
import { unionMergeWorkflowSteps } from "./merge-collections.js";
import { hasInheritedConfigField } from "./merge-layer.js";
import type {
  MergeError,
  WorkflowExtensionError,
  WorkflowInputName,
} from "./merge-types.js";

type WorkflowMap = WeaveConfig["workflows"];

const DANGEROUS_WORKFLOW_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function isRecord(value: SafeGraphValue): value is SafeGraphObject {
  return Object(value) === value && !Array.isArray(value);
}

function isStringValue(value: SafeGraphValue): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function unsafeWorkflowInput(
  argument: WorkflowInputName,
  message = "workflow input must be a descriptor-safe, schema-valid value",
): WorkflowExtensionError {
  return {
    type: "UnsafeWorkflowInput",
    argument,
    message,
  };
}

function parseWorkflow(
  argument: Exclude<WorkflowInputName, "workflowName">,
  value: SafeGraphValue,
): Result<WorkflowConfig, WorkflowExtensionError> {
  const parsed = Result.fromThrowable(
    () => WorkflowConfigSchema.safeParse(value),
    () => unsafeWorkflowInput(argument),
  )();
  if (parsed.isErr()) return err(parsed.error);
  if (!parsed.value.success) return err(unsafeWorkflowInput(argument));
  return ok(parsed.value.data);
}

function defineWorkflowEntry(
  target: WorkflowMap,
  name: string,
  value: WorkflowConfig,
): void {
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function parseWorkflowMap(
  value: SafeGraphValue,
): Result<WorkflowMap, WorkflowExtensionError> {
  if (!isRecord(value)) return err(unsafeWorkflowInput("workflowMap"));

  const names = Object.keys(value);
  for (const name of names) {
    if (DANGEROUS_WORKFLOW_KEYS.has(name)) {
      return err(
        unsafeWorkflowInput(
          "workflowMap",
          "workflow map contains a forbidden prototype key",
        ),
      );
    }
  }

  const workflows: WorkflowMap = Object.setPrototypeOf({}, null);
  for (const name of names) {
    const parsed = parseWorkflow("workflowMap", value[name]);
    if (parsed.isErr()) return err(parsed.error);
    defineWorkflowEntry(workflows, name, parsed.value);
  }
  return ok(workflows);
}

function resolveWorkflowName(
  value: SafeGraphValue,
): Result<string, WorkflowExtensionError> {
  if (!isStringValue(value)) return err(unsafeWorkflowInput("workflowName"));
  return ok(value);
}

function mergeExtensionPoints(
  base: ExtensionPoints | undefined,
  override: ExtensionPoints | undefined,
): ExtensionPoints | undefined {
  if (override === undefined) return base;
  if (base === undefined) return override;

  const beforePlan =
    override.before_plan !== undefined
      ? override.before_plan
      : base.before_plan;
  if (beforePlan === undefined) return {};
  return { before_plan: beforePlan };
}

function mergeWorkflowConfigFields(
  base: WorkflowConfig,
  override: WorkflowConfig,
  steps: WorkflowStep[],
): WorkflowConfig {
  const merged: WorkflowConfig = {
    version: override.version !== undefined ? override.version : base.version,
    steps,
  };
  const name = override.name !== undefined ? override.name : base.name;
  const description =
    override.description !== undefined
      ? override.description
      : base.description;
  const extendsTarget =
    override.extends !== undefined ? override.extends : base.extends;
  const extensionPoints = mergeExtensionPoints(
    base.extension_points,
    override.extension_points,
  );
  const promptAppend =
    override.prompt_append !== undefined
      ? override.prompt_append
      : base.prompt_append;
  const promptAppendFile =
    override.prompt_append_file !== undefined
      ? override.prompt_append_file
      : base.prompt_append_file;

  if (name !== undefined) merged.name = name;
  if (description !== undefined) merged.description = description;
  if (extendsTarget !== undefined) merged.extends = extendsTarget;
  if (extensionPoints !== undefined) merged.extension_points = extensionPoints;
  if (promptAppend !== undefined) merged.prompt_append = promptAppend;
  if (promptAppendFile !== undefined)
    merged.prompt_append_file = promptAppendFile;
  return merged;
}

function resolveBaseSteps(
  workflowName: string,
  extendsTarget: string,
  baseSteps: WorkflowStep[],
  workflowMap: WorkflowMap,
): Result<WorkflowStep[], WorkflowExtensionError> {
  if (extendsTarget === workflowName) return ok(baseSteps);

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

    const target = Object.hasOwn(workflowMap, current)
      ? workflowMap[current]
      : undefined;
    if (target === undefined) {
      return err({
        type: "UnknownExtendsTarget",
        workflowName,
        extendsTarget: current,
      });
    }

    visited.add(current);
    if (target.extends !== undefined) {
      current = target.extends;
      continue;
    }
    return ok(target.steps);
  }
}

/**
 * Trusted workflow merge implementation.
 *
 * Only callers in this module may use this seam. Public callers enter through
 * `mergeWorkflow`, which snapshots and validates every argument first.
 */
function mergeWorkflowTrusted(
  workflowName: string,
  base: WorkflowConfig,
  override: WorkflowConfig,
  workflowMap: WorkflowMap,
): Result<WorkflowConfig, WorkflowExtensionError> {
  if (override.extends === undefined) {
    return ok(
      mergeWorkflowConfigFields(
        base,
        override,
        unionMergeWorkflowSteps(base.steps, override.steps),
      ),
    );
  }

  const baseStepsResult = resolveBaseSteps(
    workflowName,
    override.extends,
    base.steps,
    workflowMap,
  );
  if (baseStepsResult.isErr()) return err(baseStepsResult.error);

  const baseSteps: WorkflowStep[] = baseStepsResult.value.map((step) => ({
    ...step,
  }));
  const baseStepNames = new Set(baseSteps.map((step) => step.name));
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

  let workingSteps: WorkflowStep[] = baseSteps.map((baseStep) => {
    const replacement = replacements.find(
      (step) => step.name === baseStep.name,
    );
    return replacement !== undefined ? replacement : baseStep;
  });

  for (const step of anchored) {
    if (step.insert_before !== undefined && step.insert_after !== undefined) {
      return err({
        type: "BothInsertBeforeAndAfter",
        workflowName,
        stepName: step.name,
      });
    }

    if (step.insert_before !== undefined) {
      const anchorIndex = workingSteps.findIndex(
        (candidate) => candidate.name === step.insert_before,
      );
      if (anchorIndex === -1) {
        return err({
          type: "UnknownInsertionAnchor",
          workflowName,
          stepName: step.name,
          anchor: step.insert_before,
        });
      }
      workingSteps = [
        ...workingSteps.slice(0, anchorIndex),
        step,
        ...workingSteps.slice(anchorIndex),
      ];
      continue;
    }

    if (step.insert_after !== undefined) {
      const anchorIndex = workingSteps.findIndex(
        (candidate) => candidate.name === step.insert_after,
      );
      if (anchorIndex === -1) {
        return err({
          type: "UnknownInsertionAnchor",
          workflowName,
          stepName: step.name,
          anchor: step.insert_after,
        });
      }
      workingSteps = [
        ...workingSteps.slice(0, anchorIndex + 1),
        step,
        ...workingSteps.slice(anchorIndex + 1),
      ];
    }
  }

  return ok(
    mergeWorkflowConfigFields(base, override, [...workingSteps, ...appends]),
  );
}

/**
 * Public workflow merge seam. Each argument is copied before any field is
 * read, then each workflow value is schema-validated before trusted merging.
 * Unsafe runtime values return a typed error instead of executing accessors.
 */
export function mergeWorkflow(
  workflowName: string,
  base: WorkflowConfig,
  override: WorkflowConfig,
  workflowMap: WorkflowMap,
): Result<WorkflowConfig, WorkflowExtensionError> {
  const copiedName = copySafeGraph(workflowName, WORKFLOW_GRAPH_COPY_BUDGET);
  const copiedBase = copySafeGraph(base, WORKFLOW_GRAPH_COPY_BUDGET);
  const copiedOverride = copySafeGraph(override, WORKFLOW_GRAPH_COPY_BUDGET);
  const copiedMap = copySafeGraph(workflowMap, WORKFLOW_GRAPH_COPY_BUDGET);

  if (copiedName.isErr()) return err(unsafeWorkflowInput("workflowName"));
  if (copiedBase.isErr()) return err(unsafeWorkflowInput("base"));
  if (copiedOverride.isErr()) return err(unsafeWorkflowInput("override"));
  if (copiedMap.isErr()) return err(unsafeWorkflowInput("workflowMap"));
  if (hasInheritedConfigField()) return err(unsafeWorkflowInput("base"));

  const name = resolveWorkflowName(copiedName.value);
  if (name.isErr()) return err(name.error);
  const baseResult = parseWorkflow("base", copiedBase.value);
  if (baseResult.isErr()) return err(baseResult.error);
  const overrideResult = parseWorkflow("override", copiedOverride.value);
  if (overrideResult.isErr()) return err(overrideResult.error);
  const mapResult = parseWorkflowMap(copiedMap.value);
  if (mapResult.isErr()) return err(mapResult.error);

  return mergeWorkflowTrusted(
    name.value,
    baseResult.value,
    overrideResult.value,
    mapResult.value,
  );
}

/** Merge workflow maps after their containing config layers were validated. */
export function mergeWorkflowRecord(
  baseWorkflows: WorkflowMap,
  overrideWorkflows: WorkflowMap,
): Result<WorkflowMap, MergeError[]> {
  const names = [
    ...Object.keys(baseWorkflows),
    ...Object.keys(overrideWorkflows),
  ];
  for (const name of names) {
    if (DANGEROUS_WORKFLOW_KEYS.has(name)) {
      return err([
        {
          type: "ConfigValidationError",
          errors: [
            {
              path: `workflows.${name}`,
              message: "workflow map contains a forbidden prototype key",
            },
          ],
        },
      ]);
    }
  }

  const combined: WorkflowMap = Object.setPrototypeOf({}, null);
  for (const [name, baseWorkflow] of Object.entries(baseWorkflows)) {
    defineWorkflowEntry(combined, name, baseWorkflow);
  }

  for (const [name, overrideWorkflow] of Object.entries(overrideWorkflows)) {
    if (!Object.hasOwn(baseWorkflows, name)) {
      defineWorkflowEntry(combined, name, overrideWorkflow);
    }
  }

  const errors: MergeError[] = [];
  for (const [name, overrideWorkflow] of Object.entries(overrideWorkflows)) {
    const baseWorkflow = Object.hasOwn(baseWorkflows, name)
      ? baseWorkflows[name]
      : undefined;
    if (baseWorkflow === undefined) continue;

    const result = mergeWorkflowTrusted(
      name,
      baseWorkflow,
      overrideWorkflow,
      combined,
    );
    if (result.isErr()) {
      errors.push({ type: "WorkflowExtensionError", error: result.error });
      continue;
    }
    defineWorkflowEntry(combined, name, result.value);
  }

  if (errors.length > 0) return err(errors);
  return ok(combined);
}
