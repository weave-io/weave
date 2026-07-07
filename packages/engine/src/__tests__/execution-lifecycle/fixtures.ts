/**
 * Shared test fixtures for execution-lifecycle module tests.
 *
 * Provides:
 * - Stable ID constants
 * - MockPlanStateProvider
 * - Minimal workflow config builders
 * - Common store setup helpers
 */

import { parseConfig } from "@weaveio/weave-core";
import {
  createExecutionLeaseId,
  createInMemoryRuntimeStore,
  createSessionSnapshotId,
  createWorkflowInstanceId,
  type PlanStateError,
  type PlanStateProvider,
  startExecution,
} from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";

// ---------------------------------------------------------------------------
// Stable IDs
// ---------------------------------------------------------------------------

export const wfId = createWorkflowInstanceId("wf-fixture-001");
export const leaseId = createExecutionLeaseId("lease-fixture-001");
export const snapshotId = createSessionSnapshotId("snap-fixture-001");

// ---------------------------------------------------------------------------
// MockPlanStateProvider
// ---------------------------------------------------------------------------

/**
 * Configurable mock for PlanStateProvider.
 *
 * - `existsMap`: maps planName → boolean (default: false = not found)
 * - `completeMap`: maps planName → boolean (default: false = incomplete)
 * - `existsError`: if set, planExists returns this error for all names
 * - `completeError`: if set, isPlanComplete returns this error for all names
 */
export class MockPlanStateProvider implements PlanStateProvider {
  constructor(
    private readonly existsMap: Record<string, boolean> = {},
    private readonly completeMap: Record<string, boolean> = {},
    private readonly existsError?: PlanStateError,
    private readonly completeError?: PlanStateError,
  ) {}

  planExists(planName: string) {
    if (this.existsError) return errAsync(this.existsError);
    const exists = this.existsMap[planName] ?? false;
    return okAsync(exists);
  }

  isPlanComplete(planName: string) {
    if (this.completeError) return errAsync(this.completeError);
    const complete = this.completeMap[planName] ?? false;
    return okAsync(complete);
  }
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Parse a .weave source string and unwrap — throws on invalid input. */
export function cfg(source: string) {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

/**
 * Create a store with a running workflow instance and active lease.
 * Returns the store, instanceId, and leaseId.
 */
export async function createRunningInstance(workflowName = "test-workflow") {
  const store = createInMemoryRuntimeStore();
  const createResult = await store.instances.create({
    workflowName,
    goal: `goal for ${workflowName}`,
    slug: workflowName.replace(/\s+/g, "-"),
  });
  if (!createResult.isOk())
    throw new Error(`Failed to create instance: ${createResult.error.message}`);
  const instanceId = createResult.value.id;

  const startResult = await startExecution(
    { workflowInstanceId: instanceId, ownerId: "test-owner" },
    store,
  );
  if (!startResult.isOk())
    throw new Error(`Failed to start execution: ${startResult.error.message}`);

  return { store, instanceId, leaseId: startResult.value.leaseId };
}
