import type {
  AgentConfig,
  DelegationTrigger,
  ToolPolicy,
  WeaveConfig,
  WorkflowConfig,
  WorkflowStep,
} from "@weave/core";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";

import { logger } from "./logger.js";
import {
  type AgentPromptTemplateContext,
  ALLOWED_TEMPLATE_PATHS,
  buildTemplateContext,
  type CategoryInput,
} from "./template-context.js";
import {
  type RendererError,
  renderTemplate,
  type TemplateContext,
} from "./template-renderer.js";
import {
  type EffectiveToolPolicy,
  evaluateEffectiveToolPolicy,
} from "./tool-policy.js";

const log = logger.child({ module: "compose" });

type AgentMode = NonNullable<AgentConfig["mode"]>;

export interface CategoryMetadata extends CategoryInput {
  patterns: string[];
  isCategory: true;
}

export interface AgentDescriptor {
  name: string;
  displayName?: string;
  description?: string;
  category?: AgentDescriptorCategory;
  composedPrompt: string;
  models: string[];
  mode: AgentMode;
  temperature?: number;
  effectiveToolPolicy: EffectiveToolPolicy;
  rawToolPolicy: ToolPolicy | undefined;
  delegationTargets: DelegationTarget[];
  skills: string[];
}

export interface AgentDescriptorCategory {
  name: string;
  description?: string;
  patterns: string[];
}

export interface DelegationTarget {
  name: string;
  description?: string;
  triggers: DelegationTrigger[];
  /** True when this target is a generated category shuttle agent. */
  isCategory: boolean;
}

/** Reason discriminants for PromptTemplateError */
export type PromptTemplateReason =
  | { kind: "MalformedSyntax"; message: string; line?: number; column?: number }
  | { kind: "UnsupportedTag"; tag: string; message: string }
  | { kind: "UnknownPath"; path: string; message: string }
  | { kind: "UnsafePath"; path: string; message: string }
  | { kind: "FunctionValue"; path: string; message: string }
  | { kind: "SectionMismatch"; message: string }
  | { kind: "UnresolvedTag"; tag: string; message: string };

export type ComposeError =
  | {
      type: "PromptSourceMissingError";
      agentName: string;
      message: string;
    }
  | {
      type: "PromptFileReadError";
      agentName: string;
      promptFilePath: string;
      message: string;
      fileErrorMessage: string;
    }
  | {
      type: "PromptTemplateError";
      agentName: string;
      sourceKind:
        | "prompt"
        | "prompt_file"
        | "prompt_append"
        | "prompt_append_file";
      promptFilePath?: string;
      message: string;
      reason: PromptTemplateReason;
    }
  | {
      type: "TemplateContextBuildError";
      agentName: string;
      message: string;
    };

function loadPromptSource(
  agentName: string,
  agentConfig: AgentConfig,
): ResultAsync<string, ComposeError> {
  if (agentConfig.prompt !== undefined) return okAsync(agentConfig.prompt);

  if (agentConfig.prompt_file === undefined) {
    return errAsync({
      type: "PromptSourceMissingError",
      agentName,
      message: `Agent "${agentName}" must define either prompt or prompt_file.`,
    });
  }

  const promptFilePath = agentConfig.prompt_file;

  return ResultAsync.fromPromise(Bun.file(promptFilePath).text(), (cause) => ({
    type: "PromptFileReadError" as const,
    agentName,
    promptFilePath,
    message: `Failed to read prompt file for agent "${agentName}": ${promptFilePath}`,
    fileErrorMessage: cause instanceof Error ? cause.message : String(cause),
  }));
}

function shouldExcludeSharedShuttleTarget(
  agentName: string,
  agentConfig: AgentConfig,
  targetName: string,
): boolean {
  if (!targetName.startsWith("shuttle-")) return false;
  // Category shuttle: any agent whose name starts with "shuttle-"
  if (agentName.startsWith("shuttle-")) return true;
  // Root shuttle equivalent: mode === "all" and no "shuttle-" prefix (generalist root)
  if (agentConfig.mode === "all" && !agentName.startsWith("shuttle-"))
    return true;
  return false;
}

function buildDelegationTargets(
  agentName: string,
  agentConfig: AgentConfig,
  config: WeaveConfig,
  allAgents: Record<string, AgentConfig>,
): DelegationTarget[] {
  if (agentConfig.tool_policy?.delegate !== "allow") return [];

  const delegationExclude = agentConfig.routing?.delegation_exclude ?? [];

  // Warn at debug level for exclusion entries that don't match any known agent.
  for (const excluded of delegationExclude) {
    if (!(excluded in allAgents)) {
      log.debug(
        { agentName, excluded },
        "delegation_exclude entry does not match any known agent (no-op)",
      );
    }
  }

  // Build the set of generated category shuttle names from config categories
  const categoryShuttleNames = new Set(
    Object.keys(config.categories).map((name) => `shuttle-${name}`),
  );

  const targets: DelegationTarget[] = [];

  for (const [targetName, targetConfig] of Object.entries(allAgents)) {
    if (targetName === agentName) continue;
    if (config.disabled.agents.includes(targetName)) continue;
    if (targetConfig.mode === "primary") continue;
    if (shouldExcludeSharedShuttleTarget(agentName, agentConfig, targetName))
      continue;
    if (delegationExclude.includes(targetName)) continue;

    targets.push({
      name: targetName,
      description: targetConfig.description,
      triggers: targetConfig.triggers ?? [],
      isCategory: categoryShuttleNames.has(targetName),
    });
  }

  return targets;
}

/**
 * Map a RendererError to a PromptTemplateReason discriminant.
 */
function mapRendererErrorToReason(
  rendererError: RendererError,
): PromptTemplateReason {
  if (rendererError.type === "MalformedTemplate") {
    return {
      kind: "MalformedSyntax",
      message: rendererError.message,
      line: rendererError.line,
      column: rendererError.column,
    };
  }

  if (rendererError.type === "UnsupportedFeature") {
    return {
      kind: "UnsupportedTag",
      tag: rendererError.tag,
      message: rendererError.message,
    };
  }

  if (rendererError.type === "UnknownPath") {
    return {
      kind: "UnknownPath",
      path: rendererError.path,
      message: rendererError.message,
    };
  }

  if (rendererError.type === "UnsafePath") {
    return {
      kind: "UnsafePath",
      path: rendererError.path,
      message: rendererError.message,
    };
  }

  if (rendererError.type === "FunctionValue") {
    return {
      kind: "FunctionValue",
      path: rendererError.path,
      message: rendererError.message,
    };
  }

  // UnresolvedTag
  return {
    kind: "UnresolvedTag",
    tag: rendererError.tag,
    message: rendererError.message,
  };
}

/**
 * Map a RendererError to a ComposeError PromptTemplateError variant.
 */
function mapRendererError(
  agentName: string,
  sourceKind: "prompt" | "prompt_file" | "prompt_append" | "prompt_append_file",
  rendererError: RendererError,
  promptFilePath?: string,
): ComposeError {
  const reason = mapRendererErrorToReason(rendererError);
  const base: ComposeError = {
    type: "PromptTemplateError",
    agentName,
    sourceKind,
    message: rendererError.message,
    reason,
  };

  if (promptFilePath !== undefined) {
    return { ...base, promptFilePath };
  }

  return base;
}

/**
 * Load the append source for an agent: returns the inline prompt_append string,
 * the contents of prompt_append_file, or undefined if neither is set.
 *
 * Delegates to `loadAppendSourceFromInput` using the agent config as input.
 */
function loadAppendSource(
  agentName: string,
  agentConfig: AgentConfig,
): ResultAsync<
  { content: string; fromFile: boolean } | undefined,
  ComposeError
> {
  return loadAppendSourceFromInput(agentName, {
    prompt_append: agentConfig.prompt_append,
    prompt_append_file: agentConfig.prompt_append_file,
  });
}

/**
 * Render a template source string with the given context.
 * Returns Result<string, ComposeError>.
 *
 * AgentPromptTemplateContext is cast to TemplateContext because it satisfies
 * the structural requirements but lacks the index signature. The cast is safe
 * because all values in AgentPromptTemplateContext are TemplateContextValue-compatible.
 */
function renderPromptTemplate(
  source: string,
  context: AgentPromptTemplateContext,
  agentName: string,
  sourceKind: "prompt" | "prompt_file" | "prompt_append" | "prompt_append_file",
  promptFilePath?: string,
): Result<string, ComposeError> {
  const renderResult = renderTemplate(
    source,
    context as unknown as TemplateContext,
    { allowedPaths: ALLOWED_TEMPLATE_PATHS },
  );

  if (renderResult.isErr()) {
    return err(
      mapRendererError(
        agentName,
        sourceKind,
        renderResult.error,
        promptFilePath,
      ),
    );
  }

  return ok(renderResult.value);
}

// ---------------------------------------------------------------------------
// Workflow step prompt composition
// ---------------------------------------------------------------------------

/**
 * Scope from which an effective append was selected.
 *
 * - `step`     — the step's own `prompt_append` / `prompt_append_file` was used
 * - `workflow` — the workflow-level `prompt_append` / `prompt_append_file` was used
 *               (step had no append of its own)
 * - `none`     — neither scope had an append
 */
export type AppendScope = "step" | "workflow" | "none";

/**
 * Result of composing a workflow step prompt.
 *
 * - `composedPrompt` — the final composed prompt string (step prompt + effective append)
 * - `appendScope`    — which scope the effective append came from
 */
export interface WorkflowStepComposedPrompt {
  composedPrompt: string;
  appendScope: AppendScope;
}

// ---------------------------------------------------------------------------
// Append collision detection
// ---------------------------------------------------------------------------

/**
 * A same-scope prompt-append collision: two or more configs in the merge
 * stack both define `prompt_append` or `prompt_append_file` for the same
 * workflow or step. The config-merge layer silently applies last-defined-wins;
 * this record makes that resolution visible to tooling.
 *
 * Fields:
 * - `scope`        — whether the collision is at workflow level or step level
 * - `workflowName` — name of the workflow where the collision occurred
 * - `stepName`     — name of the step (only present when `scope === "step"`)
 * - `field`        — which append field collided
 * - `losingValue`  — the value that was overridden (from the lower-priority config)
 * - `winningValue` — the value that won (from the higher-priority config)
 * - `loserIndex`   — index into the input `configs` array of the losing config
 * - `winnerIndex`  — index into the input `configs` array of the winning config
 */
export interface AppendCollision {
  scope: "workflow" | "step";
  workflowName: string;
  stepName?: string;
  field: "prompt_append" | "prompt_append_file";
  losingValue: string;
  winningValue: string;
  loserIndex: number;
  winnerIndex: number;
}

/** Append fields checked for collisions. */
const APPEND_FIELDS = ["prompt_append", "prompt_append_file"] as const;

/**
 * Detect same-scope prompt-append collisions across an ordered list of
 * `WeaveConfig` objects (base → override priority, left to right).
 *
 * A collision occurs when two or more configs in the list both define
 * `prompt_append` or `prompt_append_file` for the same workflow or step.
 * The config-merge layer silently applies last-defined-wins; this function
 * makes that resolution visible so tooling can warn users instead of
 * silently accepting the override as healthy.
 *
 * The function is pure and never throws. It returns an empty array when
 * there are no collisions.
 *
 * @param configs - Ordered list of configs (index 0 = lowest priority).
 *   Typically: `[builtins, globalConfig, projectConfig]`.
 * @returns Array of `AppendCollision` records, one per collision detected.
 *   Multiple collisions can exist for the same workflow/step if both
 *   `prompt_append` and `prompt_append_file` collide independently.
 */
export function detectAppendCollisions(
  configs: WeaveConfig[],
): AppendCollision[] {
  const collisions: AppendCollision[] = [];

  // Collect all workflow names across all configs
  const allWorkflowNames = new Set<string>();
  for (const config of configs) {
    for (const name of Object.keys(config.workflows ?? {})) {
      allWorkflowNames.add(name);
    }
  }

  for (const workflowName of allWorkflowNames) {
    // Check workflow-level append fields
    for (const field of APPEND_FIELDS) {
      const collision = findScalarCollision(
        configs,
        (config) => config.workflows?.[workflowName]?.[field],
      );
      if (collision !== undefined) {
        collisions.push({
          scope: "workflow",
          workflowName,
          field,
          losingValue: collision.losingValue,
          winningValue: collision.winningValue,
          loserIndex: collision.loserIndex,
          winnerIndex: collision.winnerIndex,
        });
      }
    }

    // Collect all step names for this workflow across all configs
    const allStepNames = new Set<string>();
    for (const config of configs) {
      const steps = config.workflows?.[workflowName]?.steps ?? [];
      for (const step of steps) {
        allStepNames.add(step.name);
      }
    }

    for (const stepName of allStepNames) {
      for (const field of APPEND_FIELDS) {
        const collision = findScalarCollision(
          configs,
          (config) =>
            config.workflows?.[workflowName]?.steps.find(
              (s) => s.name === stepName,
            )?.[field],
        );
        if (collision !== undefined) {
          collisions.push({
            scope: "step",
            workflowName,
            stepName,
            field,
            losingValue: collision.losingValue,
            winningValue: collision.winningValue,
            loserIndex: collision.loserIndex,
            winnerIndex: collision.winnerIndex,
          });
        }
      }
    }
  }

  return collisions;
}

/**
 * Scan an ordered list of configs for a scalar field that is defined in
 * more than one config. Returns the last collision pair (loser → winner)
 * where the winner is the highest-priority config that defines the field.
 *
 * Returns `undefined` when the field is defined in at most one config.
 */
function findScalarCollision(
  configs: WeaveConfig[],
  extract: (config: WeaveConfig) => string | undefined,
):
  | {
      losingValue: string;
      winningValue: string;
      loserIndex: number;
      winnerIndex: number;
    }
  | undefined {
  // Collect all (index, value) pairs where the field is defined
  const defined: Array<{ index: number; value: string }> = [];
  for (let i = 0; i < configs.length; i++) {
    const value = extract(configs[i] as WeaveConfig);
    if (value !== undefined) {
      defined.push({ index: i, value });
    }
  }

  // No collision if fewer than two configs define the field
  if (defined.length < 2) return undefined;

  // The winner is the last (highest-priority) entry; the loser is the one before it
  const winner = defined[defined.length - 1] as {
    index: number;
    value: string;
  };
  const loser = defined[defined.length - 2] as { index: number; value: string };

  return {
    losingValue: loser.value,
    winningValue: winner.value,
    loserIndex: loser.index,
    winnerIndex: winner.index,
  };
}

/**
 * Inputs for loading a raw append source (inline string or file path).
 *
 * Mirrors the shape of `AgentConfig` append fields so the same loader can
 * be reused for both agent-level and workflow/step-level appends.
 */
interface AppendSourceInput {
  prompt_append?: string;
  prompt_append_file?: string;
}

/**
 * Load an append source from an `AppendSourceInput`.
 *
 * Returns:
 * - `{ content, fromFile: false }` when `prompt_append` is set
 * - `{ content, fromFile: true }` when `prompt_append_file` is set and readable
 * - `undefined` when neither is set
 * - `err(ComposeError)` when the file cannot be read
 */
function loadAppendSourceFromInput(
  contextLabel: string,
  input: AppendSourceInput,
): ResultAsync<
  { content: string; fromFile: boolean } | undefined,
  ComposeError
> {
  if (input.prompt_append !== undefined) {
    return okAsync({ content: input.prompt_append, fromFile: false });
  }

  if (input.prompt_append_file === undefined) {
    return okAsync(undefined);
  }

  const appendFilePath = input.prompt_append_file;

  return ResultAsync.fromPromise(Bun.file(appendFilePath).text(), (cause) => ({
    type: "PromptFileReadError" as const,
    agentName: contextLabel,
    promptFilePath: appendFilePath,
    message: `Failed to read prompt_append_file for "${contextLabel}": ${appendFilePath}`,
    fileErrorMessage: cause instanceof Error ? cause.message : String(cause),
  })).map((content) => ({ content, fromFile: true }));
}

/**
 * Compose the final prompt for a single workflow step.
 *
 * ## Precedence rules (Spec 22 Unit 4)
 *
 * 1. **Step-local precedence**: when the step declares its own
 *    `prompt_append` / `prompt_append_file`, that append is used exclusively.
 *    The workflow-level append is suppressed.
 *
 * 2. **Workflow-scope fallback**: when the step has no append of its own,
 *    the workflow-level `prompt_append` / `prompt_append_file` is applied.
 *
 * 3. **No append**: when neither scope has an append, the step prompt is
 *    returned as-is (after template rendering).
 *
 * 4. **Same-scope last-append-wins**: within a single scope, the config-merge
 *    layer is responsible for resolving multiple appends to a single value
 *    before this function is called. This function always receives at most one
 *    append per scope.
 *
 * Both the step prompt and the effective append are rendered as Mustache
 * templates against the provided `templateContext`. The append is never
 * allowed to reference untrusted artifact contents — only the bounded
 * `AgentPromptTemplateContext` paths are permitted.
 *
 * @param stepName         - Logical step identifier (used in error messages)
 * @param step             - The validated workflow step config
 * @param workflow         - The validated workflow config (provides workflow-scope append)
 * @param templateContext  - Bounded template context for Mustache rendering
 * @returns `ResultAsync<WorkflowStepComposedPrompt, ComposeError>`
 */
export function composeWorkflowStepPrompt(
  stepName: string,
  step: WorkflowStep,
  workflow: WorkflowConfig,
  templateContext: AgentPromptTemplateContext,
): ResultAsync<WorkflowStepComposedPrompt, ComposeError> {
  const contextLabel = `workflow-step:${stepName}`;

  // Render the step's primary prompt as a template
  const renderedPrimaryResult = renderPromptTemplate(
    step.prompt,
    templateContext,
    contextLabel,
    "prompt",
  );

  if (renderedPrimaryResult.isErr()) {
    return errAsync(renderedPrimaryResult.error);
  }

  const renderedPrimary = renderedPrimaryResult.value;

  // Determine effective append scope: step-local takes precedence
  const stepHasAppend =
    step.prompt_append !== undefined || step.prompt_append_file !== undefined;

  const effectiveAppendInput: AppendSourceInput = stepHasAppend
    ? {
        prompt_append: step.prompt_append,
        prompt_append_file: step.prompt_append_file,
      }
    : {
        prompt_append: workflow.prompt_append,
        prompt_append_file: workflow.prompt_append_file,
      };

  let effectiveScope: AppendScope;
  if (stepHasAppend) {
    effectiveScope = "step";
  } else if (
    workflow.prompt_append !== undefined ||
    workflow.prompt_append_file !== undefined
  ) {
    effectiveScope = "workflow";
  } else {
    effectiveScope = "none";
  }

  return loadAppendSourceFromInput(contextLabel, effectiveAppendInput).andThen(
    (appendSource): Result<WorkflowStepComposedPrompt, ComposeError> => {
      if (appendSource === undefined) {
        return ok({ composedPrompt: renderedPrimary, appendScope: "none" });
      }

      const appendSourceKind = appendSource.fromFile
        ? ("prompt_append_file" as const)
        : ("prompt_append" as const);
      const appendFilePath = appendSource.fromFile
        ? effectiveAppendInput.prompt_append_file
        : undefined;

      const renderedAppendResult = renderPromptTemplate(
        appendSource.content,
        templateContext,
        contextLabel,
        appendSourceKind,
        appendFilePath,
      );

      if (renderedAppendResult.isErr()) return err(renderedAppendResult.error);

      const composedPrompt = [renderedPrimary, renderedAppendResult.value].join(
        "\n\n",
      );

      return ok({ composedPrompt, appendScope: effectiveScope });
    },
  );
}

export function composeAgentDescriptor(
  agentName: string,
  agentConfig: AgentConfig,
  config: WeaveConfig,
  allAgents: Record<string, AgentConfig>,
  category?: CategoryMetadata,
): ResultAsync<AgentDescriptor, ComposeError> {
  const delegationTargets = buildDelegationTargets(
    agentName,
    agentConfig,
    config,
    allAgents,
  );

  const effectiveToolPolicy = evaluateEffectiveToolPolicy(
    agentConfig.tool_policy,
  );

  // Build template context
  const contextResult = buildTemplateContext({
    agentName,
    description: agentConfig.description,
    mode: agentConfig.mode ?? "subagent",
    skills: agentConfig.skills ?? [],
    category,
    effectiveToolPolicy,
    delegationTargets,
  });

  if (contextResult.isErr()) {
    return errAsync({
      type: "TemplateContextBuildError",
      agentName,
      message: `Failed to build template context for agent "${agentName}": ${contextResult.error.message}`,
    });
  }

  const templateContext = contextResult.value;
  const promptFilePath = agentConfig.prompt_file;
  const primarySourceKind: "prompt" | "prompt_file" =
    agentConfig.prompt !== undefined ? "prompt" : "prompt_file";

  return loadPromptSource(agentName, agentConfig)
    .andThen(
      (promptSource): Result<string, ComposeError> =>
        renderPromptTemplate(
          promptSource,
          templateContext,
          agentName,
          primarySourceKind,
          promptFilePath,
        ),
    )
    .andThen((renderedPrimary) =>
      loadAppendSource(agentName, agentConfig).andThen(
        (appendSource): Result<AgentDescriptor, ComposeError> => {
          const sections: string[] = [renderedPrimary];

          if (appendSource !== undefined) {
            const appendSourceKind = appendSource.fromFile
              ? ("prompt_append_file" as const)
              : ("prompt_append" as const);
            const appendFilePath = appendSource.fromFile
              ? agentConfig.prompt_append_file
              : undefined;

            const renderedAppendResult = renderPromptTemplate(
              appendSource.content,
              templateContext,
              agentName,
              appendSourceKind,
              appendFilePath,
            );

            if (renderedAppendResult.isErr())
              return err(renderedAppendResult.error);
            sections.push(renderedAppendResult.value);
          }

          const composedPrompt = sections.join("\n\n");

          return ok({
            name: agentName,
            displayName: agentConfig.display_name,
            description: agentConfig.description,
            category:
              category === undefined
                ? undefined
                : {
                    name: category.name,
                    description: category.description,
                    patterns: [...(category.patterns ?? [])],
                  },
            composedPrompt,
            models: agentConfig.models ?? [],
            mode: agentConfig.mode ?? "subagent",
            temperature: agentConfig.temperature,
            effectiveToolPolicy,
            rawToolPolicy: agentConfig.tool_policy,
            delegationTargets,
            skills: agentConfig.skills ?? [],
          });
        },
      ),
    );
}
