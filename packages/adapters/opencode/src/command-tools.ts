import type { WeaveConfig } from "@weave/core";
import type { RuntimeStore } from "@weave/engine";
import { logger } from "@weave/engine";
import { ResultAsync } from "neverthrow";

import type { OpenCodeAdapter } from "./adapter.js";
import { RuntimeCommandProjection } from "./runtime-command-projection.js";
import type {
  ProjectionResult,
  StartPlanProjectionInput,
} from "./runtime-command-projection.js";
import { DEFAULT_EXECUTION_WORKFLOW } from "./start-plan-execution.js";

const log = logger.child({ module: "command-tools" });

interface StartPlanToolDependencies {
  readonly config: WeaveConfig;
  readonly adapter: OpenCodeAdapter;
  readonly store: RuntimeStore;
}

export type StartPlanToolHandlerDeps = StartPlanToolDependencies;

interface StartPlanToolArgs {
  readonly planName: string;
  readonly workflowName?: string;
}

interface UnexpectedStartPlanToolError {
  readonly type: "UnexpectedStartPlanToolError";
  readonly planName: string;
  readonly workflowName: string;
  readonly cause: Error | { readonly message: string };
}

function toErrorCause(error: unknown): Error | { readonly message: string } {
  if (error instanceof Error) {
    return error;
  }

  return {
    message: "An unknown error occurred while running the start-plan tool",
  };
}

function buildStartPlanInput(
  dependencies: StartPlanToolDependencies,
  args: StartPlanToolArgs,
): StartPlanProjectionInput | undefined {
  const workflowName = args.workflowName ?? DEFAULT_EXECUTION_WORKFLOW;
  const planStateProvider = dependencies.adapter.planStateProvider;

  if (planStateProvider === undefined) {
    log.warn(
      { planName: args.planName, workflowName },
      "Start-plan tool called before adapter init completed",
    );
    return undefined;
  }

  return {
    planName: args.planName,
    workflowName,
    goal: `Execute plan: ${args.planName}`,
    slug: args.planName,
    ownerId: "weave:start",
    store: dependencies.store,
    planStateProvider,
    workflows: dependencies.config.workflows,
    adapter: dependencies.adapter,
  };
}

function renderProjectionResult<T>(result: ProjectionResult<T>): string {
  if (result.outcome === "success") {
    return result.message;
  }

  if (result.outcome === "failure") {
    return result.message;
  }

  if (result.hint === undefined) {
    return result.message;
  }

  return `${result.message}\nHint: ${result.hint}`;
}

function renderProviderUnavailableMessage(args: StartPlanToolArgs): string {
  const workflowName = args.workflowName ?? DEFAULT_EXECUTION_WORKFLOW;
  return `[/weave:start] Validation error (field: planStateProvider): PlanStateProvider is unavailable; call adapter.init() before starting plan "${args.planName}" (workflow: ${workflowName})`;
}

function renderUnexpectedErrorMessage(
  error: UnexpectedStartPlanToolError,
): string {
  return `[/weave:start] Unexpected error while starting plan "${error.planName}" (workflow: ${error.workflowName}): ${error.cause.message}`;
}

export function buildStartPlanToolHandler(
  dependencies: StartPlanToolDependencies,
): (args: StartPlanToolArgs) => Promise<string> {
  const projection = new RuntimeCommandProjection();
  const safeHandleStartPlan = ResultAsync.fromThrowable(
    (input: StartPlanProjectionInput) => projection.handleStartPlan(input),
    (error): UnexpectedStartPlanToolError => ({
      type: "UnexpectedStartPlanToolError",
      planName: "unknown",
      workflowName: DEFAULT_EXECUTION_WORKFLOW,
      cause: toErrorCause(error),
    }),
  );

  return async (args: StartPlanToolArgs): Promise<string> => {
    const input = buildStartPlanInput(dependencies, args);
    if (input === undefined) {
      return renderProviderUnavailableMessage(args);
    }

    log.info(
      { planName: input.planName, workflowName: input.workflowName },
      "Handling start-plan tool invocation",
    );

    const result = await safeHandleStartPlan(input)
      .map(renderProjectionResult)
      .mapErr(
        (error): UnexpectedStartPlanToolError => ({
          ...error,
          planName: input.planName,
          workflowName: input.workflowName,
        }),
      );

    return result.match(
      (message) => message,
      (error) => {
        log.error(
          {
            err: error.cause,
            planName: error.planName,
            workflowName: error.workflowName,
          },
          "Unexpected error during start-plan tool invocation",
        );
        return renderUnexpectedErrorMessage(error);
      },
    );
  };
}
