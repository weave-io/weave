import {
  DEFAULT_DELEGATION_LIMITS,
  type WeaveConfig,
} from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";

export interface EffectiveDelegationLimits {
  readonly maxChildren: number;
  readonly maxConcurrency: number;
  readonly maxDepth: number;
  readonly maxProcesses: number;
}

export type DelegationLimitsError =
  | { type: "AgentNotFound"; agentName: string }
  | {
      type: "InvalidDelegationLimits";
      field: keyof EffectiveDelegationLimits;
      value: number;
      reason: string;
    };

export interface DelegationAuthorizationInput {
  readonly limits: EffectiveDelegationLimits;
  readonly directChildren: number;
  readonly activeChildren: number;
  readonly childDepth: number;
  readonly liveProcesses: number;
}

export type DelegationAuthorizationDecision =
  | { outcome: "authorized" }
  | {
      outcome: "queued";
      reason: "max_concurrency" | "max_processes";
    }
  | { outcome: "denied"; reason: "max_children" | "max_depth" };

export type DelegationAuthorizationError = {
  type: "InvalidDelegationCount";
  field: "directChildren" | "activeChildren" | "childDepth" | "liveProcesses";
  value: number;
  reason: string;
};

function validateLimit(
  field: keyof EffectiveDelegationLimits,
  value: number,
): Result<number, DelegationLimitsError> {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return err({
      type: "InvalidDelegationLimits",
      field,
      value,
      reason: "delegation limits must be positive safe integers",
    });
  }
  if (field === "maxChildren" && value > 9) {
    return err({
      type: "InvalidDelegationLimits",
      field,
      value,
      reason: "maxChildren must be between 1 and 9",
    });
  }
  return ok(value);
}

function validateEffectiveLimits(
  limits: EffectiveDelegationLimits,
): Result<EffectiveDelegationLimits, DelegationLimitsError> {
  for (const field of [
    "maxChildren",
    "maxConcurrency",
    "maxDepth",
    "maxProcesses",
  ] as const) {
    const valid = validateLimit(field, limits[field]);
    if (valid.isErr()) return err(valid.error);
  }

  if (limits.maxConcurrency > limits.maxChildren) {
    return err({
      type: "InvalidDelegationLimits",
      field: "maxConcurrency",
      value: limits.maxConcurrency,
      reason: "maxConcurrency must not exceed maxChildren",
    });
  }

  return ok(limits);
}

/**
 * Resolve portable delegation intent for a project or a named agent.
 *
 * Agent overrides may narrow child and concurrency limits only. When an agent
 * narrows maxChildren without declaring maxConcurrency, concurrency is clamped
 * to the narrower child cap.
 */
export function resolveEffectiveDelegationLimits(
  config: WeaveConfig,
  agentName?: string,
): Result<EffectiveDelegationLimits, DelegationLimitsError> {
  const project = config.settings.delegation;
  const projectLimits: EffectiveDelegationLimits = {
    maxChildren:
      project?.max_children ?? DEFAULT_DELEGATION_LIMITS.max_children,
    maxConcurrency:
      project?.max_concurrency ??
      Math.min(
        DEFAULT_DELEGATION_LIMITS.max_concurrency,
        project?.max_children ?? DEFAULT_DELEGATION_LIMITS.max_children,
      ),
    maxDepth: project?.max_depth ?? DEFAULT_DELEGATION_LIMITS.max_depth,
    maxProcesses:
      project?.max_processes ?? DEFAULT_DELEGATION_LIMITS.max_processes,
  };
  const validProjectLimits = validateEffectiveLimits(projectLimits);
  if (validProjectLimits.isErr()) return err(validProjectLimits.error);

  let maxChildren = projectLimits.maxChildren;
  let maxConcurrency = projectLimits.maxConcurrency;

  if (agentName !== undefined) {
    const agent = config.agents[agentName];
    if (agent === undefined) return err({ type: "AgentNotFound", agentName });

    const agentMaxChildren = agent.delegation?.max_children;
    if (
      agentMaxChildren !== undefined &&
      agentMaxChildren > projectLimits.maxChildren
    ) {
      return err({
        type: "InvalidDelegationLimits",
        field: "maxChildren",
        value: agentMaxChildren,
        reason: "agent maxChildren must not exceed the project cap",
      });
    }
    const agentMaxConcurrency = agent.delegation?.max_concurrency;
    if (
      agentMaxConcurrency !== undefined &&
      agentMaxConcurrency > projectLimits.maxConcurrency
    ) {
      return err({
        type: "InvalidDelegationLimits",
        field: "maxConcurrency",
        value: agentMaxConcurrency,
        reason: "agent maxConcurrency must not exceed the project cap",
      });
    }

    maxChildren = agentMaxChildren ?? projectLimits.maxChildren;
    maxConcurrency =
      agentMaxConcurrency ??
      Math.min(projectLimits.maxConcurrency, maxChildren);
  }

  return validateEffectiveLimits({
    maxChildren,
    maxConcurrency,
    maxDepth: projectLimits.maxDepth,
    maxProcesses: projectLimits.maxProcesses,
  });
}

function validateCount(
  field: DelegationAuthorizationError["field"],
  value: number,
  allowZero: boolean,
): Result<number, DelegationAuthorizationError> {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    return err({
      type: "InvalidDelegationCount",
      field,
      value,
      reason: `${field} must be a safe integer greater than or equal to ${minimum}`,
    });
  }
  return ok(value);
}

/**
 * Decide whether one requested child may start, must queue, or is denied.
 * Adapters supply live counts and own queue/process enforcement.
 */
export function authorizeDelegation(
  input: DelegationAuthorizationInput,
): Result<
  DelegationAuthorizationDecision,
  DelegationAuthorizationError | DelegationLimitsError
> {
  const validLimits = validateEffectiveLimits(input.limits);
  if (validLimits.isErr()) return err(validLimits.error);

  for (const [field, value, allowZero] of [
    ["directChildren", input.directChildren, true],
    ["activeChildren", input.activeChildren, true],
    ["childDepth", input.childDepth, false],
    ["liveProcesses", input.liveProcesses, true],
  ] as const) {
    const valid = validateCount(field, value, allowZero);
    if (valid.isErr()) return err(valid.error);
  }

  if (input.activeChildren > input.directChildren) {
    return err({
      type: "InvalidDelegationCount",
      field: "activeChildren",
      value: input.activeChildren,
      reason: "activeChildren must not exceed directChildren",
    });
  }
  if (input.liveProcesses < input.activeChildren) {
    return err({
      type: "InvalidDelegationCount",
      field: "liveProcesses",
      value: input.liveProcesses,
      reason: "liveProcesses must include every active child",
    });
  }

  if (input.childDepth > input.limits.maxDepth) {
    return ok({ outcome: "denied", reason: "max_depth" });
  }
  if (input.directChildren >= input.limits.maxChildren) {
    return ok({ outcome: "denied", reason: "max_children" });
  }
  if (input.activeChildren >= input.limits.maxConcurrency) {
    return ok({ outcome: "queued", reason: "max_concurrency" });
  }
  if (input.liveProcesses >= input.limits.maxProcesses) {
    return ok({ outcome: "queued", reason: "max_processes" });
  }

  return ok({ outcome: "authorized" });
}
