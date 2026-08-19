import { type WeaveConfig, WeaveConfigSchema } from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";
import { mergeNonWorkflowConfig } from "./merge-fields.js";
import { MAX_CONFIG_LAYERS, validateConfigLayer } from "./merge-layer.js";
import type { MergeError } from "./merge-types.js";
import { validateMergedConfig } from "./merge-validation.js";
import { mergeWorkflow, mergeWorkflowRecord } from "./merge-workflows.js";

export type { MergeError, WorkflowExtensionError } from "./merge-types.js";

function mergeConfigLayers(
  base: WeaveConfig,
  override: WeaveConfig,
): Result<WeaveConfig, MergeError[]> {
  const workflowResult = mergeWorkflowRecord(
    base.workflows,
    override.workflows,
  );
  if (workflowResult.isErr()) return err(workflowResult.error);

  return ok(mergeNonWorkflowConfig(base, override, workflowResult.value));
}

/**
 * Merge multiple `WeaveConfig` objects using left-fold semantics.
 *
 * Priority increases left to right. Every source layer crosses the reviewed
 * core graph-copy seam and the config schema before trusted owners read it.
 * Later layers override earlier layers. Arrays use override-first union order;
 * workflows use step-aware extension semantics.
 */
export function mergeConfigsResult(
  ...configs: WeaveConfig[]
): Result<WeaveConfig, MergeError[]> {
  if (configs.length === 0) {
    const parsed = WeaveConfigSchema.safeParse({});
    if (parsed.success) return ok(parsed.data);
    return err([
      {
        type: "ConfigValidationError",
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    ]);
  }

  if (configs.length > MAX_CONFIG_LAYERS) {
    return err([
      {
        type: "ConfigValidationError",
        errors: [
          {
            path: "config",
            message: `config layer count exceeds maximum of ${MAX_CONFIG_LAYERS}`,
          },
        ],
      },
    ]);
  }

  const layers: WeaveConfig[] = [];
  for (const config of configs) {
    const validated = validateConfigLayer(config);
    if (validated.isErr()) return err(validated.error);
    layers.push(validated.value);
  }

  const first = layers[0];
  if (first === undefined) {
    return err([
      {
        type: "ConfigValidationError",
        errors: [{ path: "config", message: "config layer is missing" }],
      },
    ]);
  }

  let merged = first;
  for (const next of layers.slice(1)) {
    const result = mergeConfigLayers(merged, next);
    if (result.isErr()) return err(result.error);
    merged = result.value;
  }
  return validateMergedConfig(merged);
}

/**
 * Backwards-compatible throwing wrapper around `mergeConfigsResult`.
 * Prefer the Result-returning function for expected merge failures.
 */
export function mergeConfigs(...configs: WeaveConfig[]): WeaveConfig {
  const result = mergeConfigsResult(...configs);
  if (result.isOk()) return result.value;
  const [firstError] = result.error;
  throw firstError;
}

export { mergeWorkflow };
