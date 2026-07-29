import type { PlanTaskSnapshot } from "@weaveio/weave-engine";
import { errAsync, type ResultAsync } from "neverthrow";
import type { PiAdapterFailure } from "./errors.js";
import type { PiPlanCatalogPort } from "./plan-catalog.js";

export interface ResolveGoalPlanInput {
  readonly planName: string;
  readonly catalog: PiPlanCatalogPort;
  readonly projectRoot: string;
  readonly readSnapshot: (
    planName: string,
  ) => ResultAsync<PlanTaskSnapshot, PiAdapterFailure>;
}

function makeUnknownPlanFailure(availablePlanCount: number): PiAdapterFailure {
  return {
    code: "PlanMissing",
    phase: "plan",
    scope: { kind: "adapter" },
    impact: "operation-stopped",
    retryable: false,
    recovery: "none",
    safeMessage: `The requested plan does not exist; ${availablePlanCount} plan(s) are available.`,
    correlation: { availablePlanCount },
  };
}

/**
 * Resolves a goal plan through the adapter's catalog and controller snapshot
 * reader. The resolver performs discovery only; plan storage and parsing remain
 * behind the injected controller-style reader.
 */
export function resolveGoalPlan({
  planName,
  catalog,
  projectRoot,
  readSnapshot,
}: ResolveGoalPlanInput): ResultAsync<PlanTaskSnapshot, PiAdapterFailure> {
  return catalog.listPlanNames(projectRoot).andThen((planNames) => {
    if (!planNames.includes(planName)) {
      return errAsync(makeUnknownPlanFailure(planNames.length));
    }

    return readSnapshot(planName);
  });
}
