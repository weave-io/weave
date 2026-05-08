import { type WeaveConfig, WeaveConfigSchema } from "@weave/core";

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

function deepMerge2(base: WeaveConfig, override: WeaveConfig): WeaveConfig {
  return mergeValues(base, override) as WeaveConfig;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
 *
 * **Immutability:** Input configs are never mutated.
 *
 * @param configs - Zero or more configs to merge. If no configs are provided,
 *   returns the default (empty) `WeaveConfig`. If exactly one config is
 *   provided, returns it as-is.
 */
export function mergeConfigs(...configs: WeaveConfig[]): WeaveConfig {
  if (configs.length === 0) {
    return WeaveConfigSchema.parse({});
  }
  if (configs.length === 1) {
    return configs[0] as WeaveConfig;
  }
  return configs.reduce((acc, next) => deepMerge2(acc, next));
}
