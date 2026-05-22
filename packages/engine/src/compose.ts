import type {
  AgentConfig,
  DelegationTrigger,
  ToolPolicy,
  WeaveConfig,
} from "@weave/core";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
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
 */
function loadAppendSource(
  agentName: string,
  agentConfig: AgentConfig,
): ResultAsync<
  { content: string; fromFile: boolean } | undefined,
  ComposeError
> {
  if (agentConfig.prompt_append !== undefined) {
    return okAsync({ content: agentConfig.prompt_append, fromFile: false });
  }

  if (agentConfig.prompt_append_file === undefined) {
    return okAsync(undefined);
  }

  const appendFilePath = agentConfig.prompt_append_file;

  return ResultAsync.fromPromise(Bun.file(appendFilePath).text(), (cause) => ({
    type: "PromptFileReadError" as const,
    agentName,
    promptFilePath: appendFilePath,
    message: `Failed to read prompt_append_file for agent "${agentName}": ${appendFilePath}`,
    fileErrorMessage: cause instanceof Error ? cause.message : String(cause),
  })).map((content) => ({ content, fromFile: true }));
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
