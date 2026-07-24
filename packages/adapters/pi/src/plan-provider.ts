/**
 * Adapter-owned `PlanStateProvider` wiring (Spec 33 §16;
 * docs/adapter-boundary.md "Plan State Provider"). The engine owns the
 * `PlanStateProvider` interface, `validatePlanName`, and all transition
 * policy; the concrete Bun filesystem implementation lives in
 * `@weaveio/weave-config` (`BunFilesystemPlanStateProvider`). This module
 * only supplies the thin, adapter-scoped factory that binds it to the
 * trusted project root - it must never reimplement plan parsing/CAS logic.
 */
import { BunFilesystemPlanStateProvider } from "@weaveio/weave-config";
import type { PlanStateProvider } from "@weaveio/weave-engine";
import { DEFAULT_PLAN_COORDINATOR } from "@weaveio/weave-engine";

export const PI_PLAN_COORDINATOR_AGENT = DEFAULT_PLAN_COORDINATOR;

/**
 * Builds the production `PlanStateProvider` for a trusted project root. Must
 * only be called after project trust is confirmed (Spec 33 §7.3) - the
 * provider itself proves canonical-root containment and no-follow symlink
 * rejection on every call, but the *decision* to construct it at all is the
 * adapter's trust gate.
 */
export function createPiPlanStateProvider(
  projectRoot: string,
): PlanStateProvider {
  return new BunFilesystemPlanStateProvider(projectRoot);
}
