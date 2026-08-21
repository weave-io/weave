import {
  type AgentConfig,
  type CategoryConfig,
  copySafeGraph,
  type SafeGraphObject,
  type SafeGraphValue,
  type WeaveConfig,
  WeaveConfigSchema,
} from "@weaveio/weave-core";
import { err, ok, Result } from "neverthrow";
import { CONFIG_GRAPH_COPY_BUDGET } from "./merge-budgets.js";
import { boundConfigIssues } from "./merge-diagnostics.js";
import type { MergeError } from "./merge-types.js";

/** Maximum number of source layers accepted by the left-fold merge. */
export const MAX_CONFIG_LAYERS = 128;

const CONFIG_LAYER_UNSAFE_MESSAGE =
  "config layers must contain only own, enumerable, writable data properties on plain objects or arrays";
const DANGEROUS_CONFIG_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);
const CONFIG_FIELD_NAMES = new Set([
  "agents",
  "categories",
  "disabled",
  "settings",
  "workflows",
  "extend_before_plan",
  "name",
  "description",
  "display_name",
  "prompt",
  "prompt_file",
  "prompt_append",
  "prompt_append_file",
  "models",
  "review_models",
  "temperature",
  "mode",
  "tool_policy",
  "read",
  "write",
  "execute",
  "delegate",
  "network",
  "delegation",
  "max_children",
  "max_concurrency",
  "max_depth",
  "max_processes",
  "routing",
  "delegation_exclude",
  "skills",
  "triggers",
  "fast",
  "log_level",
  "runtime",
  "journal",
  "usage",
  "log",
  "enforce_permissions",
  "adapters",
  "strict",
  "retention_days",
  "max_entries",
  "detail_retention_days",
  "max_observations",
  "max_segment_bytes",
  "max_segments",
  "hooks",
  "version",
  "steps",
  "extends",
  "extension_points",
  "before_plan",
  "type",
  "agent",
  "completion",
  "inputs",
  "outputs",
  "on_reject",
  "reconciliation_handlers",
  "reason",
  "insert_before",
  "insert_after",
  "method",
  "plan_name",
  "role",
]);

type ValidationIssue = { path: string; message: string };

function isRecord(value: SafeGraphValue): value is SafeGraphObject {
  return Object(value) === value && !Array.isArray(value);
}

function isStringValue(value: SafeGraphValue): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function unsafeConfigLayer(): MergeError {
  return {
    type: "ConfigValidationError",
    errors: [{ path: "config", message: CONFIG_LAYER_UNSAFE_MESSAGE }],
  };
}

/** Return whether Object.prototype defines an accepted config field. */
export function hasInheritedConfigField(): boolean {
  for (const key of CONFIG_FIELD_NAMES) {
    if (Object.getOwnPropertyDescriptor(Object.prototype, key) !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * The core graph copy intentionally preserves ordinary string keys. Config
 * maps need one extra semantic guard because assigning a dangerous map key to
 * a normal result object could invoke Object.prototype setters.
 *
 * The input has already crossed `copySafeGraph`, so this walk only inspects
 * trusted, acyclic data and does not repeat descriptor, prototype, or bounds
 * validation.
 */
function containsDangerousConfigKey(value: SafeGraphValue): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsDangerousConfigKey(entry));
  }
  if (!isRecord(value)) return false;

  for (const key of Object.keys(value)) {
    if (DANGEROUS_CONFIG_KEYS.has(key)) return true;
    if (containsDangerousConfigKey(value[key])) return true;
  }
  return false;
}

function defineOwn(
  target: SafeGraphObject,
  key: string,
  value: SafeGraphValue,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function cloneRecord(value: SafeGraphObject): SafeGraphObject {
  const copy: SafeGraphObject = Object.setPrototypeOf({}, null);
  for (const key of Object.keys(value)) {
    defineOwn(copy, key, value[key]);
  }
  return copy;
}

function resolvedPromptPath(value: SafeGraphValue): string | undefined {
  if (!isStringValue(value) || !value.startsWith("/")) return undefined;
  return value;
}

/** Remove resolved prompt paths from the schema input without changing source. */
function withoutResolvedPromptPaths(value: SafeGraphValue): SafeGraphValue {
  if (!isRecord(value)) return value;

  const copy = cloneRecord(value);
  for (const ownerField of ["agents", "categories"]) {
    const owners = copy[ownerField];
    if (!isRecord(owners)) continue;

    const ownersCopy = cloneRecord(owners);
    for (const ownerName of Object.keys(owners)) {
      const owner = owners[ownerName];
      if (!isRecord(owner)) continue;

      const promptFile = resolvedPromptPath(owner.prompt_file);
      const promptAppendFile = resolvedPromptPath(owner.prompt_append_file);
      if (promptFile === undefined && promptAppendFile === undefined) continue;

      const ownerCopy = cloneRecord(owner);
      if (promptFile !== undefined) delete ownerCopy.prompt_file;
      if (promptAppendFile !== undefined) delete ownerCopy.prompt_append_file;
      defineOwn(ownersCopy, ownerName, ownerCopy);
    }
    defineOwn(copy, ownerField, ownersCopy);
  }
  return copy;
}

function withoutEmptyExtensionDirective(value: SafeGraphValue): SafeGraphValue {
  if (!isRecord(value)) return value;
  const extension = value.extend_before_plan;
  if (!isRecord(extension) || !Array.isArray(extension.steps)) return value;
  if (extension.steps.length !== 0) return value;

  const copy = cloneRecord(value);
  delete copy.extend_before_plan;
  return copy;
}

function defineAgentEntry(
  target: WeaveConfig["agents"],
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
  target: WeaveConfig["categories"],
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

function restoreResolvedPromptPaths(
  config: WeaveConfig,
  source: SafeGraphValue,
): WeaveConfig {
  if (!isRecord(source)) return config;

  const agents: WeaveConfig["agents"] = Object.setPrototypeOf({}, null);
  for (const [name, targetAgent] of Object.entries(config.agents)) {
    defineAgentEntry(agents, name, targetAgent);
  }

  const sourceAgents = source.agents;
  if (isRecord(sourceAgents)) {
    for (const name of Object.keys(sourceAgents)) {
      const sourceAgent = sourceAgents[name];
      const targetAgent = agents[name];
      if (!isRecord(sourceAgent) || targetAgent === undefined) continue;

      const promptFile = resolvedPromptPath(sourceAgent.prompt_file);
      const promptAppendFile = resolvedPromptPath(
        sourceAgent.prompt_append_file,
      );
      if (promptFile === undefined && promptAppendFile === undefined) continue;

      const restored: AgentConfig = { ...targetAgent };
      if (promptFile !== undefined) restored.prompt_file = promptFile;
      if (promptAppendFile !== undefined)
        restored.prompt_append_file = promptAppendFile;
      defineAgentEntry(agents, name, restored);
    }
  }

  const categories: WeaveConfig["categories"] = Object.setPrototypeOf({}, null);
  for (const [name, targetCategory] of Object.entries(config.categories)) {
    defineCategoryEntry(categories, name, targetCategory);
  }

  const sourceCategories = source.categories;
  if (isRecord(sourceCategories)) {
    for (const name of Object.keys(sourceCategories)) {
      const sourceCategory = sourceCategories[name];
      const targetCategory = categories[name];
      if (!isRecord(sourceCategory) || targetCategory === undefined) continue;

      const promptAppendFile = resolvedPromptPath(
        sourceCategory.prompt_append_file,
      );
      if (promptAppendFile === undefined) continue;
      defineCategoryEntry(categories, name, {
        ...targetCategory,
        prompt_append_file: promptAppendFile,
      });
    }
  }

  return { ...config, agents, categories };
}

function issuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "config";
  return path.map((part) => String(part)).join(".");
}

function validationError(issues: readonly ValidationIssue[]): MergeError {
  const bounded = boundConfigIssues(issues);
  return {
    type: "ConfigValidationError",
    errors:
      bounded.length > 0
        ? bounded
        : [{ path: "config", message: "config layer validation failed" }],
  };
}

/**
 * Copy and validate one public config layer before any merge owner reads it.
 * The descriptor-safe graph boundary lives in core; this module owns only
 * config-specific prompt-path and dangerous-key semantics.
 */
export function validateConfigLayer(
  layer: WeaveConfig,
): Result<WeaveConfig, MergeError[]> {
  const copied = copySafeGraph(layer, CONFIG_GRAPH_COPY_BUDGET);
  if (copied.isErr()) return err([unsafeConfigLayer()]);
  if (hasInheritedConfigField() || containsDangerousConfigKey(copied.value)) {
    return err([unsafeConfigLayer()]);
  }

  const schemaInput = withoutEmptyExtensionDirective(
    withoutResolvedPromptPaths(copied.value),
  );
  const parsed = Result.fromThrowable(
    () => WeaveConfigSchema.safeParse(schemaInput),
    () => unsafeConfigLayer(),
  )();
  if (parsed.isErr()) return err([parsed.error]);
  if (!parsed.value.success) {
    return err([
      validationError(
        parsed.value.error.issues.map((issue) => ({
          path: issuePath(issue.path),
          message: issue.message,
        })),
      ),
    ]);
  }

  return ok(restoreResolvedPromptPaths(parsed.value.data, copied.value));
}
