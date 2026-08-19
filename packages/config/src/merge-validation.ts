import {
  DEFAULT_DELEGATION_LIMITS,
  type WeaveConfig,
} from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";
import { boundConfigIssues } from "./merge-diagnostics.js";
import { validateConfigLayer } from "./merge-layer.js";
import type { MergeError } from "./merge-types.js";

/** Validate effective delegation limits after all layers have been merged. */
export function validateMergedConfig(
  config: WeaveConfig,
): Result<WeaveConfig, MergeError[]> {
  // A fold can create values that no individual source layer could contain,
  // such as a union of two bounded lists. Re-enter the authoritative config
  // schema after the fold so the returned value is never outside its bounds.
  const schemaResult = validateConfigLayer(config);
  if (schemaResult.isErr()) return err(schemaResult.error);

  const validatedConfig = schemaResult.value;
  const issues: Array<{ path: string; message: string }> = [];
  const projectDelegation = validatedConfig.settings.delegation;
  const projectMaxChildren =
    projectDelegation?.max_children ?? DEFAULT_DELEGATION_LIMITS.max_children;
  const declaredProjectMaxConcurrency = projectDelegation?.max_concurrency;
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

  for (const [agentName, agent] of Object.entries(validatedConfig.agents)) {
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
    return err([
      {
        type: "ConfigValidationError",
        errors: boundConfigIssues(issues),
      },
    ]);
  }
  return ok(validatedConfig);
}
