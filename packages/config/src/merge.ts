import {
  AdapterSettingsSchema,
  type AgentConfig,
  type AgentDelegationConfig,
  type CategoryConfig,
  DEFAULT_DELEGATION_LIMITS,
  type DelegationSettings,
  type ExtendBeforePlan,
  type ExtensionPoints,
  type JsonValue,
  type RoutingConfig,
  type RuntimeJournalSettings,
  type RuntimeLogSettings,
  type RuntimeSettings,
  type RuntimeUsageSettings,
  type SettingsConfig,
  type ToolPolicy,
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
 * Top-level merge error type. Workflow failures preserve their focused error;
 * effective config validation failures carry precise schema-style paths.
 */
export type MergeError =
  | {
      type: "WorkflowExtensionError";
      error: WorkflowExtensionError;
    }
  | {
      type: "ConfigValidationError";
      errors: Array<{ path: string; message: string }>;
    };

// ---------------------------------------------------------------------------
// Named merge contracts — schema-derived owner types
// ---------------------------------------------------------------------------

type AgentMap = WeaveConfig["agents"];
type CategoryMap = WeaveConfig["categories"];
type WorkflowMap = WeaveConfig["workflows"];
type DisabledConfig = WeaveConfig["disabled"];
type AdapterSettings = NonNullable<SettingsConfig["adapters"]>;
type JsonRecord = Exclude<Extract<JsonValue, object>, JsonValue[]>;

// ---------------------------------------------------------------------------
// Array union-merge (override entries first, then unseen base entries)
// ---------------------------------------------------------------------------

function unionMergeStrings(
  base: readonly string[],
  override: readonly string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

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

function unionMergeWorkflowSteps(
  base: readonly WorkflowStep[],
  override: readonly WorkflowStep[],
): WorkflowStep[] {
  const seen = new Set<string>();
  const result: WorkflowStep[] = [];

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

function unionMergeJsonArrays(
  base: readonly JsonValue[],
  override: readonly JsonValue[],
): JsonValue[] {
  const seen = new Set<string>();
  const result: JsonValue[] = [];

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

function mergeOptionalStringArray(
  base: readonly string[] | undefined,
  override: readonly string[] | undefined,
): string[] | undefined {
  if (override === undefined) return base === undefined ? undefined : [...base];
  if (base === undefined) return [...override];
  return unionMergeStrings(base, override);
}

// ---------------------------------------------------------------------------
// Adapter JSON merge — parsed JsonValue contracts, no representation checks
// ---------------------------------------------------------------------------

function jsonRecord(value: JsonValue): JsonRecord | undefined {
  if (value instanceof Object && !Array.isArray(value)) {
    return value;
  }
  return undefined;
}

function mergeJsonRecords(base: JsonRecord, override: JsonRecord): JsonRecord {
  const merged: JsonRecord = { ...base };
  for (const key of Object.keys(override)) {
    const overrideValue = override[key];
    if (overrideValue === undefined) continue;
    const baseValue = base[key];
    merged[key] =
      baseValue === undefined
        ? overrideValue
        : mergeJsonValue(baseValue, overrideValue);
  }
  return merged;
}

function mergeJsonValue(base: JsonValue, override: JsonValue): JsonValue {
  if (Array.isArray(base) && Array.isArray(override)) {
    return unionMergeJsonArrays(base, override);
  }

  const baseRecord = jsonRecord(base);
  const overrideRecord = jsonRecord(override);
  if (baseRecord !== undefined && overrideRecord !== undefined) {
    return mergeJsonRecords(baseRecord, overrideRecord);
  }

  return override;
}

function mergeAdapterSettings(
  base: AdapterSettings | undefined,
  override: AdapterSettings | undefined,
): AdapterSettings | undefined {
  if (override === undefined) return base;
  if (base === undefined) return override;
  const merged: AdapterSettings = { ...base };
  for (const key of Object.keys(override)) {
    const overrideValue = override[key];
    if (overrideValue === undefined) continue;
    const baseValue = base[key];
    merged[key] =
      baseValue === undefined
        ? overrideValue
        : mergeJsonValue(baseValue, overrideValue);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Object-field merge contracts
// ---------------------------------------------------------------------------

function mergeToolPolicy(
  base: ToolPolicy | undefined,
  override: ToolPolicy | undefined,
): ToolPolicy | undefined {
  if (override === undefined) return base;
  if (base === undefined) return override;
  const merged: ToolPolicy = {};
  const read = override.read !== undefined ? override.read : base.read;
  if (read !== undefined) merged.read = read;
  const write = override.write !== undefined ? override.write : base.write;
  if (write !== undefined) merged.write = write;
  const execute =
    override.execute !== undefined ? override.execute : base.execute;
  if (execute !== undefined) merged.execute = execute;
  const delegate =
    override.delegate !== undefined ? override.delegate : base.delegate;
  if (delegate !== undefined) merged.delegate = delegate;
  const network =
    override.network !== undefined ? override.network : base.network;
  if (network !== undefined) merged.network = network;
  return merged;
}

function mergeDelegationSettings(
  base: DelegationSettings | undefined,
  override: DelegationSettings | undefined,
): DelegationSettings | undefined {
  if (override === undefined) return base;
  if (base === undefined) return override;
  const merged: DelegationSettings = {};
  const maxChildren =
    override.max_children !== undefined
      ? override.max_children
      : base.max_children;
  if (maxChildren !== undefined) merged.max_children = maxChildren;
  const maxConcurrency =
    override.max_concurrency !== undefined
      ? override.max_concurrency
      : base.max_concurrency;
  if (maxConcurrency !== undefined) merged.max_concurrency = maxConcurrency;
  const maxDepth =
    override.max_depth !== undefined ? override.max_depth : base.max_depth;
  if (maxDepth !== undefined) merged.max_depth = maxDepth;
  const maxProcesses =
    override.max_processes !== undefined
      ? override.max_processes
      : base.max_processes;
  if (maxProcesses !== undefined) merged.max_processes = maxProcesses;
  return merged;
}

function mergeAgentDelegation(
  base: AgentDelegationConfig | undefined,
  override: AgentDelegationConfig | undefined,
): AgentDelegationConfig | undefined {
  if (override === undefined) return base;
  if (base === undefined) return override;
  const merged: AgentDelegationConfig = {};
  const maxChildren =
    override.max_children !== undefined
      ? override.max_children
      : base.max_children;
  if (maxChildren !== undefined) merged.max_children = maxChildren;
  const maxConcurrency =
    override.max_concurrency !== undefined
      ? override.max_concurrency
      : base.max_concurrency;
  if (maxConcurrency !== undefined) merged.max_concurrency = maxConcurrency;
  return merged;
}

function mergeRouting(
  base: RoutingConfig | undefined,
  override: RoutingConfig | undefined,
): RoutingConfig | undefined {
  if (override === undefined) return base;
  if (base === undefined) return override;
  const merged: RoutingConfig = {};
  const exclude = mergeOptionalStringArray(
    base.delegation_exclude,
    override.delegation_exclude,
  );
  if (exclude !== undefined) merged.delegation_exclude = exclude;
  return merged;
}

function mergeExtensionPoints(
  base: ExtensionPoints | undefined,
  override: ExtensionPoints | undefined,
): ExtensionPoints | undefined {
  if (override === undefined) return base;
  if (base === undefined) return override;
  const merged: ExtensionPoints = {};
  const beforePlan =
    override.before_plan !== undefined
      ? override.before_plan
      : base.before_plan;
  if (beforePlan !== undefined) merged.before_plan = beforePlan;
  return merged;
}

function mergeRuntimeJournal(
  base: RuntimeJournalSettings,
  override: RuntimeJournalSettings,
): RuntimeJournalSettings {
  return {
    strict: override.strict !== undefined ? override.strict : base.strict,
    retention_days:
      override.retention_days !== undefined
        ? override.retention_days
        : base.retention_days,
    max_entries:
      override.max_entries !== undefined
        ? override.max_entries
        : base.max_entries,
  };
}

function mergeRuntimeUsage(
  base: RuntimeUsageSettings,
  override: RuntimeUsageSettings,
): RuntimeUsageSettings {
  return {
    detail_retention_days:
      override.detail_retention_days !== undefined
        ? override.detail_retention_days
        : base.detail_retention_days,
    max_observations:
      override.max_observations !== undefined
        ? override.max_observations
        : base.max_observations,
  };
}

function mergeRuntimeLog(
  base: RuntimeLogSettings,
  override: RuntimeLogSettings,
): RuntimeLogSettings {
  return {
    max_segment_bytes:
      override.max_segment_bytes !== undefined
        ? override.max_segment_bytes
        : base.max_segment_bytes,
    max_segments:
      override.max_segments !== undefined
        ? override.max_segments
        : base.max_segments,
  };
}

function mergeRuntimeSettings(
  base: RuntimeSettings,
  override: RuntimeSettings,
): RuntimeSettings {
  return {
    journal: mergeRuntimeJournal(base.journal, override.journal),
    usage: mergeRuntimeUsage(base.usage, override.usage),
    log: mergeRuntimeLog(base.log, override.log),
  };
}

function mergeSettings(
  base: SettingsConfig,
  override: SettingsConfig,
): SettingsConfig {
  const merged: SettingsConfig = {
    log_level:
      override.log_level !== undefined ? override.log_level : base.log_level,
    runtime: mergeRuntimeSettings(base.runtime, override.runtime),
  };
  const delegation = mergeDelegationSettings(
    base.delegation,
    override.delegation,
  );
  if (delegation !== undefined) merged.delegation = delegation;
  const enforcePermissions =
    override.enforce_permissions !== undefined
      ? override.enforce_permissions
      : base.enforce_permissions;
  if (enforcePermissions !== undefined) {
    merged.enforce_permissions = enforcePermissions;
  }
  const adapters = mergeAdapterSettings(base.adapters, override.adapters);
  if (adapters !== undefined) merged.adapters = adapters;
  return merged;
}

function mergeDisabled(
  base: DisabledConfig,
  override: DisabledConfig,
): DisabledConfig {
  return {
    agents: unionMergeStrings(base.agents, override.agents),
    hooks: unionMergeStrings(base.hooks, override.hooks),
    skills: unionMergeStrings(base.skills, override.skills),
  };
}

function mergeExtendBeforePlan(
  base: ExtendBeforePlan,
  override: ExtendBeforePlan,
): ExtendBeforePlan {
  return { steps: unionMergeStrings(base.steps, override.steps) };
}

function mergeAgentConfig(
  base: AgentConfig,
  override: AgentConfig,
): AgentConfig {
  const merged: AgentConfig = {};
  const name = override.name !== undefined ? override.name : base.name;
  if (name !== undefined) merged.name = name;
  const description =
    override.description !== undefined
      ? override.description
      : base.description;
  if (description !== undefined) merged.description = description;
  const displayName =
    override.display_name !== undefined
      ? override.display_name
      : base.display_name;
  if (displayName !== undefined) merged.display_name = displayName;
  const prompt = override.prompt !== undefined ? override.prompt : base.prompt;
  if (prompt !== undefined) merged.prompt = prompt;
  const promptFile =
    override.prompt_file !== undefined
      ? override.prompt_file
      : base.prompt_file;
  if (promptFile !== undefined) merged.prompt_file = promptFile;
  const promptAppend =
    override.prompt_append !== undefined
      ? override.prompt_append
      : base.prompt_append;
  if (promptAppend !== undefined) merged.prompt_append = promptAppend;
  const promptAppendFile =
    override.prompt_append_file !== undefined
      ? override.prompt_append_file
      : base.prompt_append_file;
  if (promptAppendFile !== undefined) {
    merged.prompt_append_file = promptAppendFile;
  }
  const models = mergeOptionalStringArray(base.models, override.models);
  if (models !== undefined) merged.models = models;
  const reviewModels = mergeOptionalStringArray(
    base.review_models,
    override.review_models,
  );
  if (reviewModels !== undefined) merged.review_models = reviewModels;
  const temperature =
    override.temperature !== undefined
      ? override.temperature
      : base.temperature;
  if (temperature !== undefined) merged.temperature = temperature;
  const mode = override.mode !== undefined ? override.mode : base.mode;
  if (mode !== undefined) merged.mode = mode;
  const toolPolicy = mergeToolPolicy(base.tool_policy, override.tool_policy);
  if (toolPolicy !== undefined) merged.tool_policy = toolPolicy;
  const delegation = mergeAgentDelegation(base.delegation, override.delegation);
  if (delegation !== undefined) merged.delegation = delegation;
  const routing = mergeRouting(base.routing, override.routing);
  if (routing !== undefined) merged.routing = routing;
  const skills = mergeOptionalStringArray(base.skills, override.skills);
  if (skills !== undefined) merged.skills = skills;
  const triggers = mergeOptionalStringArray(base.triggers, override.triggers);
  if (triggers !== undefined) merged.triggers = triggers;
  const fast = override.fast !== undefined ? override.fast : base.fast;
  if (fast !== undefined) merged.fast = fast;
  return merged;
}

function mergeCategoryConfig(
  base: CategoryConfig,
  override: CategoryConfig,
): CategoryConfig {
  const merged: CategoryConfig = {
    description:
      override.description !== undefined
        ? override.description
        : base.description,
  };
  const name = override.name !== undefined ? override.name : base.name;
  if (name !== undefined) merged.name = name;
  const models = mergeOptionalStringArray(base.models, override.models);
  if (models !== undefined) merged.models = models;
  const triggers = mergeOptionalStringArray(base.triggers, override.triggers);
  if (triggers !== undefined) merged.triggers = triggers;
  const fast = override.fast !== undefined ? override.fast : base.fast;
  if (fast !== undefined) merged.fast = fast;
  const temperature =
    override.temperature !== undefined
      ? override.temperature
      : base.temperature;
  if (temperature !== undefined) merged.temperature = temperature;
  const toolPolicy = mergeToolPolicy(base.tool_policy, override.tool_policy);
  if (toolPolicy !== undefined) merged.tool_policy = toolPolicy;
  const promptAppend =
    override.prompt_append !== undefined
      ? override.prompt_append
      : base.prompt_append;
  if (promptAppend !== undefined) merged.prompt_append = promptAppend;
  const promptAppendFile =
    override.prompt_append_file !== undefined
      ? override.prompt_append_file
      : base.prompt_append_file;
  if (promptAppendFile !== undefined) {
    merged.prompt_append_file = promptAppendFile;
  }
  return merged;
}

function mergeAgentMap(base: AgentMap, override: AgentMap): AgentMap {
  const merged = { ...base };
  for (const [name, overrideAgent] of Object.entries(override)) {
    const baseAgent = base[name];
    merged[name] =
      baseAgent === undefined
        ? overrideAgent
        : mergeAgentConfig(baseAgent, overrideAgent);
  }
  return merged;
}

function mergeCategoryMap(
  base: CategoryMap,
  override: CategoryMap,
): CategoryMap {
  const merged = { ...base };
  for (const [name, overrideCategory] of Object.entries(override)) {
    const baseCategory = base[name];
    merged[name] =
      baseCategory === undefined
        ? overrideCategory
        : mergeCategoryConfig(baseCategory, overrideCategory);
  }
  return merged;
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
  if (name !== undefined) merged.name = name;
  const description =
    override.description !== undefined
      ? override.description
      : base.description;
  if (description !== undefined) merged.description = description;
  const extendsTarget =
    override.extends !== undefined ? override.extends : base.extends;
  if (extendsTarget !== undefined) merged.extends = extendsTarget;
  const extensionPoints = mergeExtensionPoints(
    base.extension_points,
    override.extension_points,
  );
  if (extensionPoints !== undefined) merged.extension_points = extensionPoints;
  const promptAppend =
    override.prompt_append !== undefined
      ? override.prompt_append
      : base.prompt_append;
  if (promptAppend !== undefined) merged.prompt_append = promptAppend;
  const promptAppendFile =
    override.prompt_append_file !== undefined
      ? override.prompt_append_file
      : base.prompt_append_file;
  if (promptAppendFile !== undefined) {
    merged.prompt_append_file = promptAppendFile;
  }
  return merged;
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
  workflowMap: WorkflowMap,
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
  workflowMap: WorkflowMap,
): Result<WorkflowConfig, WorkflowExtensionError> {
  // If the override does not use `extends`, fall back to plain deep-merge
  // (backwards-compat: existing configs without `extends` keep union-merge
  // semantics for the steps array via the named workflow-field merge path).
  if (override.extends === undefined) {
    return ok(
      mergeWorkflowConfigFields(
        base,
        override,
        unionMergeWorkflowSteps(base.steps, override.steps),
      ),
    );
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

    const insertBefore = step.insert_before;
    if (insertBefore !== undefined) {
      const anchorIndex = workingSteps.findIndex(
        (s) => s.name === insertBefore,
      );
      if (anchorIndex === -1) {
        return err({
          type: "UnknownInsertionAnchor",
          workflowName,
          stepName: step.name,
          anchor: insertBefore,
        });
      }
      workingSteps = [
        ...workingSteps.slice(0, anchorIndex),
        step,
        ...workingSteps.slice(anchorIndex),
      ];
      continue;
    }

    const insertAfter = step.insert_after;
    if (insertAfter !== undefined) {
      const anchorIndex = workingSteps.findIndex((s) => s.name === insertAfter);
      if (anchorIndex === -1) {
        return err({
          type: "UnknownInsertionAnchor",
          workflowName,
          stepName: step.name,
          anchor: insertAfter,
        });
      }
      workingSteps = [
        ...workingSteps.slice(0, anchorIndex + 1),
        step,
        ...workingSteps.slice(anchorIndex + 1),
      ];
    }
  }

  // Step 4: Append remaining steps
  workingSteps = [...workingSteps, ...appends];

  return ok(mergeWorkflowConfigFields(base, override, workingSteps));
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
  baseWorkflows: WorkflowMap,
  overrideWorkflows: WorkflowMap,
): Result<WorkflowMap, MergeError[]> {
  // Build the combined map: start with base, then apply overrides
  const combined = { ...baseWorkflows };

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

function adapterSettingsIssues(
  config: WeaveConfig,
): Array<{ path: string; message: string }> {
  const adapters = config.settings.adapters;
  if (adapters === undefined) return [];
  const parsed = AdapterSettingsSchema.safeParse(adapters);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => ({
    path: ["settings", "adapters", ...issue.path].join("."),
    message: issue.message,
  }));
}

function validateMergedConfig(
  config: WeaveConfig,
): Result<WeaveConfig, MergeError[]> {
  const issues: Array<{ path: string; message: string }> =
    adapterSettingsIssues(config);
  const project = config.settings.delegation;
  const projectMaxChildren =
    project?.max_children ?? DEFAULT_DELEGATION_LIMITS.max_children;
  const declaredProjectMaxConcurrency = project?.max_concurrency;
  const projectMaxConcurrency = Math.min(
    declaredProjectMaxConcurrency ?? DEFAULT_DELEGATION_LIMITS.max_concurrency,
    projectMaxChildren,
  );

  if (
    declaredProjectMaxConcurrency !== undefined &&
    declaredProjectMaxConcurrency > projectMaxChildren
  ) {
    issues.push({
      path: "settings.delegation.max_concurrency",
      message: "max_concurrency must be less than or equal to max_children",
    });
  }

  for (const [agentName, agent] of Object.entries(config.agents)) {
    const limits = agent.delegation;
    if (limits === undefined) continue;

    if (
      limits.max_children !== undefined &&
      limits.max_children > projectMaxChildren
    ) {
      issues.push({
        path: `agents.${agentName}.delegation.max_children`,
        message: "agent max_children may not exceed the project cap",
      });
    }

    const effectiveMaxChildren = limits.max_children ?? projectMaxChildren;
    if (
      limits.max_concurrency !== undefined &&
      limits.max_concurrency > projectMaxConcurrency
    ) {
      issues.push({
        path: `agents.${agentName}.delegation.max_concurrency`,
        message: "agent max_concurrency may not exceed the project cap",
      });
    } else if (
      limits.max_concurrency !== undefined &&
      limits.max_concurrency > effectiveMaxChildren
    ) {
      issues.push({
        path: `agents.${agentName}.delegation.max_concurrency`,
        message:
          "agent max_concurrency must be less than or equal to effective max_children",
      });
    }
  }

  if (issues.length > 0) {
    return err([{ type: "ConfigValidationError", errors: issues }]);
  }
  return ok(config);
}

function mergeConfigLayers(
  base: WeaveConfig,
  override: WeaveConfig,
): Result<WeaveConfig, MergeError[]> {
  // Handle workflows specially; merge everything else with named field contracts.
  //
  // before-plan ownership note:
  //   `extension_points` is a plain object field on WorkflowConfig — it passes
  //   through mergeWorkflowRecord → mergeWorkflow → mergeWorkflowConfigFields
  //   as a deep-merge, so `extension_points.before_plan` is preserved from
  //   whichever layer sets it.
  //
  //   `extend_before_plan` is a top-level WeaveConfig field — it is merged by
  //   named union-merge of `steps` (override entries first, then base entries
  //   not already present).
  //
  //   Both fields are engine-visible only after merge resolution completes.
  //   The engine is responsible for checking `extension_points.before_plan` on
  //   the target workflow before applying `extend_before_plan` entries — the
  //   merge layer does not enforce that cross-field constraint.
  const workflowResult = mergeWorkflowRecord(
    base.workflows,
    override.workflows,
  );
  if (workflowResult.isErr()) return err(workflowResult.error);

  return ok({
    agents: mergeAgentMap(base.agents, override.agents),
    categories: mergeCategoryMap(base.categories, override.categories),
    disabled: mergeDisabled(base.disabled, override.disabled),
    settings: mergeSettings(base.settings, override.settings),
    workflows: workflowResult.value,
    extend_before_plan: mergeExtendBeforePlan(
      base.extend_before_plan,
      override.extend_before_plan,
    ),
  });
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
 * - *Scalars* (string, number, boolean, enum, including `fast true`): last-defined wins.
 *   Omission in a higher-priority layer preserves a lower-priority `fast true`.
 * - *Objects* (e.g. `agents`, `categories`, `tool_policy`): recursive deep-merge — only
 *   keys present in the override are updated; all other keys are preserved
 * - *Arrays* (e.g. `models`, `disabled.agents`, string `triggers`): union-merge — override
 *   entries come first, then base entries not already present (deduped by
 *   `JSON.stringify` equality, which is exact string equality for triggers); order reflects priority (highest first)
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
  const [first, ...rest] = configs;
  if (first === undefined) {
    return ok(WeaveConfigSchema.parse({}));
  }

  // Validate every source before merging. Otherwise a later override could
  // hide an invalid adapter block and bypass the per-source contract.
  const sourceIssues = configs.flatMap((config) =>
    adapterSettingsIssues(config),
  );
  if (sourceIssues.length > 0) {
    return err([{ type: "ConfigValidationError", errors: sourceIssues }]);
  }

  if (rest.length === 0) {
    return validateMergedConfig(first);
  }

  let acc = first;
  for (const next of rest) {
    const result = mergeConfigLayers(acc, next);
    if (result.isErr()) return err(result.error);
    acc = result.value;
  }
  return validateMergedConfig(acc);
}

/**
 * Merge multiple `WeaveConfig` objects using left-fold semantics.
 *
 * Priority increases left to right — later configs override earlier ones.
 * Typical call order: `mergeConfigs(builtins, globalConfig, projectConfig)`.
 *
 * **Merge rules per value type:**
 * - *Scalars* (string, number, boolean, enum, including `fast true`): last-defined wins.
 *   Omission in a higher-priority layer preserves a lower-priority `fast true`.
 * - *Objects* (e.g. `agents`, `categories`, `tool_policy`): recursive deep-merge — only
 *   keys present in the override are updated; all other keys are preserved
 * - *Arrays* (e.g. `models`, `disabled.agents`, string `triggers`): union-merge — override
 *   entries come first, then base entries not already present (deduped by
 *   `JSON.stringify` equality, which is exact string equality for triggers); order reflects priority (highest first)
 * - *Workflows*: step-aware merge — same-name replacement, anchored insertion,
 *   append; `extends` chain is resolved across the merged workflow map
 *
 * **Immutability:** Input configs are never mutated.
 *
 * @param configs - Zero or more configs to merge. If no configs are provided,
 *   returns the default (empty) `WeaveConfig`. A single config is still checked
 *   against effective delegation limits.
 *
 * @deprecated Prefer `mergeConfigsResult` which returns `Result<WeaveConfig, MergeError[]>`
 *   and avoids throwing. This wrapper throws the first merge error.
 */
export function mergeConfigs(...configs: WeaveConfig[]): WeaveConfig {
  const result = mergeConfigsResult(...configs);
  if (result.isOk()) return result.value;
  const [firstError] = result.error;
  throw firstError;
}
