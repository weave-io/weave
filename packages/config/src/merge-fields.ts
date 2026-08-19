import type {
  AgentConfig,
  AgentDelegationConfig,
  CategoryConfig,
  DelegationSettings,
  ExtendBeforePlan,
  RoutingConfig,
  RuntimeJournalSettings,
  RuntimeLogSettings,
  RuntimeSettings,
  RuntimeUsageSettings,
  SettingsConfig,
  ToolPolicy,
  WeaveConfig,
} from "@weaveio/weave-core";
import {
  mergeAdapterSettings,
  mergeOptionalStringArray,
  unionMergeStrings,
} from "./merge-collections.js";

type AgentMap = WeaveConfig["agents"];
type CategoryMap = WeaveConfig["categories"];
type DisabledConfig = WeaveConfig["disabled"];
function mergeToolPolicy(
  base: ToolPolicy | undefined,
  override: ToolPolicy | undefined,
): ToolPolicy | undefined {
  if (override === undefined) return base;
  if (base === undefined) return override;

  const merged: ToolPolicy = {};
  const read = override.read !== undefined ? override.read : base.read;
  const write = override.write !== undefined ? override.write : base.write;
  const execute =
    override.execute !== undefined ? override.execute : base.execute;
  const delegate =
    override.delegate !== undefined ? override.delegate : base.delegate;
  const network =
    override.network !== undefined ? override.network : base.network;
  if (read !== undefined) merged.read = read;
  if (write !== undefined) merged.write = write;
  if (execute !== undefined) merged.execute = execute;
  if (delegate !== undefined) merged.delegate = delegate;
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
  const maxConcurrency =
    override.max_concurrency !== undefined
      ? override.max_concurrency
      : base.max_concurrency;
  const maxDepth =
    override.max_depth !== undefined ? override.max_depth : base.max_depth;
  const maxProcesses =
    override.max_processes !== undefined
      ? override.max_processes
      : base.max_processes;
  if (maxChildren !== undefined) merged.max_children = maxChildren;
  if (maxConcurrency !== undefined) merged.max_concurrency = maxConcurrency;
  if (maxDepth !== undefined) merged.max_depth = maxDepth;
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
  const maxConcurrency =
    override.max_concurrency !== undefined
      ? override.max_concurrency
      : base.max_concurrency;
  if (maxChildren !== undefined) merged.max_children = maxChildren;
  if (maxConcurrency !== undefined) merged.max_concurrency = maxConcurrency;
  return merged;
}

function mergeRouting(
  base: RoutingConfig | undefined,
  override: RoutingConfig | undefined,
): RoutingConfig | undefined {
  if (override === undefined) return base;
  if (base === undefined) return override;

  const delegationExclude = mergeOptionalStringArray(
    base.delegation_exclude,
    override.delegation_exclude,
  );
  const merged: RoutingConfig = {};
  if (delegationExclude !== undefined)
    merged.delegation_exclude = delegationExclude;
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
  if (enforcePermissions !== undefined)
    merged.enforce_permissions = enforcePermissions;

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
  const description =
    override.description !== undefined
      ? override.description
      : base.description;
  const displayName =
    override.display_name !== undefined
      ? override.display_name
      : base.display_name;
  const prompt = override.prompt !== undefined ? override.prompt : base.prompt;
  const promptFile =
    override.prompt_file !== undefined
      ? override.prompt_file
      : base.prompt_file;
  const promptAppend =
    override.prompt_append !== undefined
      ? override.prompt_append
      : base.prompt_append;
  const promptAppendFile =
    override.prompt_append_file !== undefined
      ? override.prompt_append_file
      : base.prompt_append_file;
  const models = mergeOptionalStringArray(base.models, override.models);
  const reviewModels = mergeOptionalStringArray(
    base.review_models,
    override.review_models,
  );
  const temperature =
    override.temperature !== undefined
      ? override.temperature
      : base.temperature;
  const mode = override.mode !== undefined ? override.mode : base.mode;
  const toolPolicy = mergeToolPolicy(base.tool_policy, override.tool_policy);
  const delegation = mergeAgentDelegation(base.delegation, override.delegation);
  const routing = mergeRouting(base.routing, override.routing);
  const skills = mergeOptionalStringArray(base.skills, override.skills);
  const triggers = mergeOptionalStringArray(base.triggers, override.triggers);
  const fast = override.fast !== undefined ? override.fast : base.fast;

  if (name !== undefined) merged.name = name;
  if (description !== undefined) merged.description = description;
  if (displayName !== undefined) merged.display_name = displayName;
  if (prompt !== undefined) merged.prompt = prompt;
  if (promptFile !== undefined) merged.prompt_file = promptFile;
  if (promptAppend !== undefined) merged.prompt_append = promptAppend;
  if (promptAppendFile !== undefined)
    merged.prompt_append_file = promptAppendFile;
  if (models !== undefined) merged.models = models;
  if (reviewModels !== undefined) merged.review_models = reviewModels;
  if (temperature !== undefined) merged.temperature = temperature;
  if (mode !== undefined) merged.mode = mode;
  if (toolPolicy !== undefined) merged.tool_policy = toolPolicy;
  if (delegation !== undefined) merged.delegation = delegation;
  if (routing !== undefined) merged.routing = routing;
  if (skills !== undefined) merged.skills = skills;
  if (triggers !== undefined) merged.triggers = triggers;
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
  const models = mergeOptionalStringArray(base.models, override.models);
  const triggers = mergeOptionalStringArray(base.triggers, override.triggers);
  const fast = override.fast !== undefined ? override.fast : base.fast;
  const temperature =
    override.temperature !== undefined
      ? override.temperature
      : base.temperature;
  const toolPolicy = mergeToolPolicy(base.tool_policy, override.tool_policy);
  const promptAppend =
    override.prompt_append !== undefined
      ? override.prompt_append
      : base.prompt_append;
  const promptAppendFile =
    override.prompt_append_file !== undefined
      ? override.prompt_append_file
      : base.prompt_append_file;

  if (name !== undefined) merged.name = name;
  if (models !== undefined) merged.models = models;
  if (triggers !== undefined) merged.triggers = triggers;
  if (fast !== undefined) merged.fast = fast;
  if (temperature !== undefined) merged.temperature = temperature;
  if (toolPolicy !== undefined) merged.tool_policy = toolPolicy;
  if (promptAppend !== undefined) merged.prompt_append = promptAppend;
  if (promptAppendFile !== undefined)
    merged.prompt_append_file = promptAppendFile;
  return merged;
}

function defineAgentEntry(
  target: AgentMap,
  name: string,
  value: AgentConfig,
): void {
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function defineCategoryEntry(
  target: CategoryMap,
  name: string,
  value: CategoryConfig,
): void {
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function mergeAgentMap(base: AgentMap, override: AgentMap): AgentMap {
  const merged: AgentMap = Object.setPrototypeOf({}, null);
  for (const [name, baseAgent] of Object.entries(base)) {
    defineAgentEntry(merged, name, baseAgent);
  }
  for (const [name, overrideAgent] of Object.entries(override)) {
    const baseAgent = Object.hasOwn(base, name) ? base[name] : undefined;
    defineAgentEntry(
      merged,
      name,
      baseAgent === undefined
        ? overrideAgent
        : mergeAgentConfig(baseAgent, overrideAgent),
    );
  }
  return merged;
}

function mergeCategoryMap(
  base: CategoryMap,
  override: CategoryMap,
): CategoryMap {
  const merged: CategoryMap = Object.setPrototypeOf({}, null);
  for (const [name, baseCategory] of Object.entries(base)) {
    defineCategoryEntry(merged, name, baseCategory);
  }
  for (const [name, overrideCategory] of Object.entries(override)) {
    const baseCategory = Object.hasOwn(base, name) ? base[name] : undefined;
    defineCategoryEntry(
      merged,
      name,
      baseCategory === undefined
        ? overrideCategory
        : mergeCategoryConfig(baseCategory, overrideCategory),
    );
  }
  return merged;
}

/** Merge every top-level owner except workflows. */
export function mergeNonWorkflowConfig(
  base: WeaveConfig,
  override: WeaveConfig,
  workflows: WeaveConfig["workflows"],
): WeaveConfig {
  return {
    agents: mergeAgentMap(base.agents, override.agents),
    categories: mergeCategoryMap(base.categories, override.categories),
    disabled: mergeDisabled(base.disabled, override.disabled),
    settings: mergeSettings(base.settings, override.settings),
    workflows,
    extend_before_plan: mergeExtendBeforePlan(
      base.extend_before_plan,
      override.extend_before_plan,
    ),
  };
}
