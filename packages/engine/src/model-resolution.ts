import type { AgentConfig } from "@weaveio/weave-core";

/**
 * Last-resort model used only when adapters provide no override, UI-selected
 * model, Weave model preferences, or system default.
 */
export const DEFAULT_FALLBACK_MODEL = "claude-sonnet-4-5";

/** Explicit model intent plus adapter-owned harness context. */
export interface ModelResolutionInput {
  /** Logical agent name from the normalized Weave config. */
  agentName: string;
  /** Adapter-facing mode metadata from the agent descriptor. */
  agentMode?: AgentConfig["mode"];
  /** Ordered model preferences declared by the agent descriptor. */
  agentModels?: string[];
  /** Ordered model preferences supplied by category context. */
  categoryModels?: string[];
  /** Hard adapter/harness per-agent override. */
  overrideModel?: string;
  /** Harness UI-selected model, when the adapter can supply one. */
  uiSelectedModel?: string;
  /** Harness/system default model. */
  systemDefault?: string;
  /** Optional adapter-supplied model registry for availability filtering. */
  availableModels?: Set<string>;
}

/** Provenance of the selected model candidate. */
export type ResolutionSource =
  | "override"
  | "ui-selected"
  | "category-preference"
  | "agent-preference"
  | "system-default"
  | "constant-fallback";

/** Resolved model plus the priority branch that selected it. */
export interface ModelResolutionResult {
  model: string;
  source: ResolutionSource;
}

/**
 * Resolve adapter-facing model intent with explicit harness context.
 *
 * This helper is pure and never queries harness UI or model registry state by
 * itself. Adapters decide which optional harness values to pass in.
 */
export function resolveAdapterModelIntent(
  input: ModelResolutionInput,
): ModelResolutionResult {
  if (input.overrideModel !== undefined) {
    return { model: input.overrideModel, source: "override" };
  }

  if (input.uiSelectedModel !== undefined && input.agentMode !== "subagent") {
    return { model: input.uiSelectedModel, source: "ui-selected" };
  }

  const categoryModel = firstAvailable(
    input.categoryModels,
    input.availableModels,
  );
  if (categoryModel !== undefined) {
    return { model: categoryModel, source: "category-preference" };
  }

  const agentModel = firstAvailable(input.agentModels, input.availableModels);
  if (agentModel !== undefined) {
    return { model: agentModel, source: "agent-preference" };
  }

  if (input.systemDefault !== undefined) {
    return { model: input.systemDefault, source: "system-default" };
  }

  return { model: DEFAULT_FALLBACK_MODEL, source: "constant-fallback" };
}

function firstAvailable(
  models: string[] | undefined,
  availableModels: Set<string> | undefined,
): string | undefined {
  if (models === undefined) return undefined;

  for (const model of models) {
    if (isAvailable(model, availableModels)) return model;
  }

  return undefined;
}

function isAvailable(
  model: string,
  availableModels: Set<string> | undefined,
): boolean {
  if (availableModels === undefined) return true;
  return availableModels.has(model);
}
