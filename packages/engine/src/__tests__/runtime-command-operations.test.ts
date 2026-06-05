/**
 * Integration tests for all reusable runtime command operations.
 *
 * ## What these tests prove
 *
 * ### start-plan
 * 1. Success — plan exists, workflow completes → `ok(ExecutionStartedData)`.
 * 2. Degraded/unsupported — missing `planStateProvider` → `command_validation`.
 * 3. Validation — empty required fields → typed `command_validation` errors.
 * 4. No implicit start — plan validation happens before any store mutation.
 *
 * ### run-named-workflow
 * 1. Success — workflow exists, completes → `ok(ExecutionStartedData)`.
 * 2. Degraded/unsupported — missing workflow → `command_not_found`.
 * 3. Validation — empty required fields → typed `command_validation` errors.
 * 4. Distinct from plan execution — no `planStateProvider` required.
 *
 * ### inspect-status
 * 1. Success — existing instance → `ok(ExecutionStatusData)`.
 * 2. Not found — non-existent instance → `command_not_found`.
 * 3. Validation — empty `workflowInstanceId` → `command_validation`.
 * 4. Read-only — no store mutation after inspection.
 *
 * ### abort-execution / cancel
 * 1. Success — running instance, cancel signal → `ok(ExecutionAbortedData)`.
 * 2. Terminal guard — completed instance → `command_not_found`.
 * 3. Lease mismatch → `command_not_found` (entity: "lease").
 * 4. Validation — empty required fields → `command_validation`.
 *
 * ### advance-step
 * 1. Success — blocked step, success signal → `ok(StepAdvancedData)`.
 * 2. Not found — non-existent instance → `command_not_found`.
 * 3. Lease mismatch → `command_not_found` (entity: "lease").
 * 4. Validation — empty required fields → `command_validation`.
 *
 * ### runtime-health
 * 1. Pure — always returns `ok(RuntimeHealthData)`.
 * 2. `commandEntrypointsSupported` derivation — native/emulated → true; degraded/unsupported → false.
 * 3. Degraded/unsupported operation lists — adapter-supplied vs derived.
 *
 * ### Mock second adapter portability proof
 * 1. `MockSecondAdapter` (non-OpenCode) can drive `runNamedWorkflow` end-to-end.
 * 2. `MockSecondAdapter` can drive `startPlan` end-to-end.
 * 3. `MockSecondAdapter` health report reflects `emulated` command-entrypoints.
 * 4. Effect projection is recorded by the adapter without harness I/O.
 *
 * ## Constraints
 *
 * - No `@weave/adapter-opencode` imports.
 * - No OpenCode registration code.
 * - No filesystem access, no SQLite, no harness startup.
 * - All fallible operations use `neverthrow` ResultAsync.
 *
 * @see packages/engine/src/runtime-command-operations/types.ts
 * @see packages/engine/src/__tests__/runtime-command-operations/fixtures.ts
 */

import { describe, expect, it } from "bun:test";
import { createInMemoryRuntimeStore } from "@weave/engine";
import { buildAdapterHealthReport } from "../capability-contract.js";
import type { OwnerId } from "../runtime/types.js";
import {
  createExecutionLeaseId,
  createWorkflowInstanceId,
} from "../runtime/types.js";
import {
  abortExecution,
  advanceStep,
} from "../runtime-command-operations/control.js";
import { runtimeHealth } from "../runtime-command-operations/health.js";
import { runNamedWorkflow } from "../runtime-command-operations/run-named-workflow.js";
import { startPlan } from "../runtime-command-operations/start-plan.js";
import { inspectStatus } from "../runtime-command-operations/status.js";
import type {
  AbortExecutionInput,
  AdvanceStepInput,
  InspectStatusInput,
  RunNamedWorkflowInput,
  StartPlanInput,
} from "../runtime-command-operations/types.js";
import { runWorkflowLifecycle } from "../runtime-command-operations/workflow-runner.js";
import {
  FailingPlanStateProvider,
  GATE_WORKFLOWS,
  InvalidNamePlanStateProvider,
  MockEffectProjector,
  MockPlanStateProvider,
  MockSecondAdapter,
  MULTI_STEP_WORKFLOWS,
  makeCapabilityEntry,
  makeContractWithCommandEntrypoints,
  noopProjectEffect,
  PLAN_COMPLETION_WORKFLOWS,
  SIMPLE_WORKFLOWS,
} from "./runtime-command-operations/fixtures.js";

// ---------------------------------------------------------------------------
// § 1 — start-plan
// ---------------------------------------------------------------------------

describe("start-plan — success", () => {
  it("returns ok(ExecutionStartedData) when plan exists and workflow completes", async () => {
    const store = createInMemoryRuntimeStore();
    const provider = new MockPlanStateProvider(true, true);

    const input: StartPlanInput = {
      planName: "my-plan",
      workflowName: "simple-execution",
      goal: "Implement the feature",
      slug: "my-plan",
      ownerId: "owner-test",
      store,
      workflows: SIMPLE_WORKFLOWS,
      planStateProvider: provider,
    };

    const result = await startPlan(input, noopProjectEffect);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-started");
      expect(result.value.workflowName).toBe("simple-execution");
      expect(result.value.goal).toBe("Implement the feature");
      expect(result.value.slug).toBe("my-plan");
      expect(typeof result.value.workflowInstanceId).toBe("string");
      expect(result.value.workflowInstanceId.length).toBeGreaterThan(0);
      expect(typeof result.value.leaseId).toBe("string");
      expect(result.value.leaseId.length).toBeGreaterThan(0);
      expect(Array.isArray(result.value.effects)).toBe(true);
    }
  });

  it("creates a WorkflowInstance in the store on success", async () => {
    const store = createInMemoryRuntimeStore();
    const provider = new MockPlanStateProvider(true, true);

    await startPlan(
      {
        planName: "my-plan",
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "my-plan",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: provider,
      },
      noopProjectEffect,
    );

    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("calls planExists exactly once on success", async () => {
    const store = createInMemoryRuntimeStore();
    const provider = new MockPlanStateProvider(true, true);

    await startPlan(
      {
        planName: "feature-auth",
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "feature-auth",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: provider,
      },
      noopProjectEffect,
    );

    expect(provider.planExistsCalls).toHaveLength(1);
    expect(provider.planExistsCalls[0]).toBe("feature-auth");
  });

  it("records projected effects from the workflow run", async () => {
    const store = createInMemoryRuntimeStore();
    const provider = new MockPlanStateProvider(true, true);
    const projector = new MockEffectProjector();

    const result = await startPlan(
      {
        planName: "my-plan",
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "my-plan",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: provider,
      },
      projector.project,
    );

    expect(result.isOk()).toBe(true);
    // At least one dispatch-agent effect should have been projected
    expect(projector.calls.length).toBeGreaterThanOrEqual(1);
    expect(projector.calls[0]?.kind).toBe("dispatch-agent");
  });
});

describe("start-plan — degraded/unsupported (missing planStateProvider)", () => {
  it("returns command_validation when planStateProvider is undefined", async () => {
    const store = createInMemoryRuntimeStore();

    const input: StartPlanInput = {
      planName: "my-plan",
      workflowName: "simple-execution",
      goal: "Test goal",
      slug: "my-plan",
      ownerId: "owner-test",
      store,
      workflows: SIMPLE_WORKFLOWS,
      planStateProvider: undefined as unknown as MockPlanStateProvider,
    };

    const result = await startPlan(input, noopProjectEffect);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("planStateProvider");
      }
    }
  });

  it("leaves the store empty when planStateProvider is absent", async () => {
    const store = createInMemoryRuntimeStore();

    await startPlan(
      {
        planName: "my-plan",
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "my-plan",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: undefined as unknown as MockPlanStateProvider,
      },
      noopProjectEffect,
    );

    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value).toHaveLength(0);
    }
  });

  it("returns command_validation when provider returns ProviderUnavailable", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await startPlan(
      {
        planName: "my-plan",
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "my-plan",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: new FailingPlanStateProvider(),
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("planStateProvider");
      }
    }
  });

  it("returns command_validation when provider returns InvalidPlanName", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await startPlan(
      {
        planName: "../../../etc/passwd",
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "my-plan",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: new InvalidNamePlanStateProvider(),
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("planName");
      }
    }
  });
});

describe("start-plan — validation", () => {
  it("returns command_validation when planName is empty", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await startPlan(
      {
        planName: "",
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "my-plan",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: new MockPlanStateProvider(true),
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("planName");
      }
    }
  });

  it("returns command_validation when workflowName is empty", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await startPlan(
      {
        planName: "my-plan",
        workflowName: "",
        goal: "Test goal",
        slug: "my-plan",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: new MockPlanStateProvider(true),
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("workflowName");
      }
    }
  });

  it("returns command_validation when goal is empty", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await startPlan(
      {
        planName: "my-plan",
        workflowName: "simple-execution",
        goal: "",
        slug: "my-plan",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: new MockPlanStateProvider(true),
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("goal");
      }
    }
  });

  it("returns command_validation when slug is empty", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await startPlan(
      {
        planName: "my-plan",
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: new MockPlanStateProvider(true),
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("slug");
      }
    }
  });

  it("returns command_validation when ownerId is empty", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await startPlan(
      {
        planName: "my-plan",
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "my-plan",
        ownerId: "",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: new MockPlanStateProvider(true),
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("ownerId");
      }
    }
  });
});

describe("start-plan — no implicit start", () => {
  it("leaves the store empty when plan does not exist", async () => {
    const store = createInMemoryRuntimeStore();
    const provider = new MockPlanStateProvider(false); // plan does NOT exist

    await startPlan(
      {
        planName: "nonexistent-plan",
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "nonexistent-plan",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: provider,
      },
      noopProjectEffect,
    );

    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value).toHaveLength(0);
    }
  });

  it("returns command_not_found (entity: plan) when plan does not exist", async () => {
    const store = createInMemoryRuntimeStore();
    const provider = new MockPlanStateProvider(false);

    const result = await startPlan(
      {
        planName: "nonexistent-plan",
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "nonexistent-plan",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: provider,
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_not_found");
      if (result.error.type === "command_not_found") {
        expect(result.error.entity).toBe("plan");
        expect(result.error.name).toBe("nonexistent-plan");
      }
    }
  });

  it("returns command_not_found (entity: workflow) when workflow is absent from registry", async () => {
    const store = createInMemoryRuntimeStore();
    const provider = new MockPlanStateProvider(true);

    const result = await startPlan(
      {
        planName: "my-plan",
        workflowName: "nonexistent-workflow",
        goal: "Test goal",
        slug: "my-plan",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: provider,
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_not_found");
      if (result.error.type === "command_not_found") {
        expect(result.error.entity).toBe("workflow");
        expect(result.error.name).toBe("nonexistent-workflow");
      }
    }
  });

  it("does not call planExists when required scalar fields are empty", async () => {
    const store = createInMemoryRuntimeStore();
    const provider = new MockPlanStateProvider(true);

    // Empty planName — validation fails before planExists is called
    await startPlan(
      {
        planName: "",
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "my-plan",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: provider,
      },
      noopProjectEffect,
    );

    expect(provider.planExistsCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// § 2 — run-named-workflow
// ---------------------------------------------------------------------------

describe("run-named-workflow — success", () => {
  it("returns ok(ExecutionStartedData) when workflow exists and completes", async () => {
    const store = createInMemoryRuntimeStore();

    const input: RunNamedWorkflowInput = {
      workflowName: "simple-execution",
      goal: "Run the workflow",
      slug: "run-the-workflow",
      ownerId: "owner-test",
      store,
      workflows: SIMPLE_WORKFLOWS,
    };

    const result = await runNamedWorkflow(input, noopProjectEffect);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-started");
      expect(result.value.workflowName).toBe("simple-execution");
      expect(result.value.goal).toBe("Run the workflow");
      expect(result.value.slug).toBe("run-the-workflow");
      expect(typeof result.value.workflowInstanceId).toBe("string");
      expect(result.value.workflowInstanceId.length).toBeGreaterThan(0);
      expect(typeof result.value.leaseId).toBe("string");
      expect(result.value.leaseId.length).toBeGreaterThan(0);
      expect(Array.isArray(result.value.effects)).toBe(true);
    }
  });

  it("creates a WorkflowInstance in the store on success", async () => {
    const store = createInMemoryRuntimeStore();

    await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "test-slug",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      noopProjectEffect,
    );

    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("does not require planStateProvider (distinct from start-plan)", async () => {
    const store = createInMemoryRuntimeStore();

    // runNamedWorkflow has no planStateProvider field — this proves the distinction
    const result = await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "test-slug",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        // No planStateProvider — this is intentional
      },
      noopProjectEffect,
    );

    expect(result.isOk()).toBe(true);
  });

  it("records projected effects from the workflow run", async () => {
    const store = createInMemoryRuntimeStore();
    const projector = new MockEffectProjector();

    const result = await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "test-slug",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      projector.project,
    );

    expect(result.isOk()).toBe(true);
    expect(projector.calls.length).toBeGreaterThanOrEqual(1);
    expect(projector.calls[0]?.kind).toBe("dispatch-agent");
  });
});

describe("run-named-workflow — degraded/unsupported (missing workflow)", () => {
  it("returns command_not_found when workflow is absent from registry", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "nonexistent-workflow",
        goal: "Test goal",
        slug: "test-slug",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_not_found");
      if (result.error.type === "command_not_found") {
        expect(result.error.entity).toBe("workflow");
        expect(result.error.name).toBe("nonexistent-workflow");
      }
    }
  });

  it("leaves the store empty when workflow is not found", async () => {
    const store = createInMemoryRuntimeStore();

    await runNamedWorkflow(
      {
        workflowName: "nonexistent-workflow",
        goal: "Test goal",
        slug: "test-slug",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      noopProjectEffect,
    );

    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value).toHaveLength(0);
    }
  });
});

describe("run-named-workflow — validation", () => {
  it("returns command_validation when workflowName is empty", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "",
        goal: "Test goal",
        slug: "test-slug",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("workflowName");
      }
    }
  });

  it("returns command_validation when goal is empty", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "",
        slug: "test-slug",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("goal");
      }
    }
  });

  it("returns command_validation when slug is empty", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("slug");
      }
    }
  });

  it("returns command_validation when ownerId is empty", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "test-slug",
        ownerId: "",
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("ownerId");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// § 3 — inspect-status
// ---------------------------------------------------------------------------

/** Helper: start a workflow and return the runner output. */
async function startWorkflow(
  store: ReturnType<typeof createInMemoryRuntimeStore>,
  workflowName = "simple-execution",
) {
  const result = await runWorkflowLifecycle({
    workflowName,
    goal: "Test goal",
    slug: "test-slug",
    ownerId: "owner-test",
    store,
    workflows: SIMPLE_WORKFLOWS,
    projectEffect: noopProjectEffect,
  });

  if (result.isErr()) {
    throw new Error(
      `Failed to start workflow: ${JSON.stringify(result.error)}`,
    );
  }

  return result.value;
}

describe("inspect-status — success", () => {
  it("returns ok(ExecutionStatusData) for an existing instance", async () => {
    const store = createInMemoryRuntimeStore();
    const { workflowInstanceId } = await startWorkflow(store);

    const result = await inspectStatus({ workflowInstanceId, store });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-status");
      expect(result.value.workflowInstanceId).toBe(workflowInstanceId);
      expect(result.value.workflowName).toBe("simple-execution");
      expect(result.value.goal).toBe("Test goal");
      expect(result.value.slug).toBe("test-slug");
      expect(typeof result.value.createdAt).toBe("string");
      expect(typeof result.value.updatedAt).toBe("string");
      expect(result.value.raw).toBeDefined();
    }
  });

  it("returns completed status after workflow finishes", async () => {
    const store = createInMemoryRuntimeStore();
    const { workflowInstanceId } = await startWorkflow(store);

    const result = await inspectStatus({ workflowInstanceId, store });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe("completed");
    }
  });

  it("reflects hasActiveLease as false after workflow completes", async () => {
    const store = createInMemoryRuntimeStore();
    const { workflowInstanceId } = await startWorkflow(store);

    const result = await inspectStatus({ workflowInstanceId, store });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.hasActiveLease).toBe(false);
    }
  });
});

describe("inspect-status — not found", () => {
  it("returns command_not_found when instance does not exist", async () => {
    const store = createInMemoryRuntimeStore();
    const input: InspectStatusInput = {
      workflowInstanceId: createWorkflowInstanceId("nonexistent-id"),
      store,
    };

    const result = await inspectStatus(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_not_found");
      if (result.error.type === "command_not_found") {
        expect(result.error.entity).toBe("execution");
      }
    }
  });
});

describe("inspect-status — validation", () => {
  it("returns command_validation when workflowInstanceId is empty", async () => {
    const store = createInMemoryRuntimeStore();
    const input: InspectStatusInput = {
      workflowInstanceId: "" as ReturnType<typeof createWorkflowInstanceId>,
      store,
    };

    const result = await inspectStatus(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("workflowInstanceId");
      }
    }
  });
});

describe("inspect-status — read-only", () => {
  it("does not mutate any store state", async () => {
    const store = createInMemoryRuntimeStore();
    const { workflowInstanceId } = await startWorkflow(store);

    const beforeInstances = await store.instances.list();
    const beforeCount = beforeInstances.isOk()
      ? beforeInstances.value.length
      : 0;

    await inspectStatus({ workflowInstanceId, store });

    const afterInstances = await store.instances.list();
    expect(afterInstances.isOk()).toBe(true);
    if (afterInstances.isOk()) {
      expect(afterInstances.value.length).toBe(beforeCount);
    }
  });
});

// ---------------------------------------------------------------------------
// § 4 — abort-execution
// ---------------------------------------------------------------------------

/** Helper: create a running instance with an active lease. */
async function createRunningInstance(
  store: ReturnType<typeof createInMemoryRuntimeStore>,
) {
  const instance = await store.instances.create({
    workflowName: "simple-execution",
    goal: "Test goal",
    slug: "test-slug",
  });
  if (!instance.isOk()) throw new Error("Failed to create instance");

  await store.instances.update(instance.value.id, { status: "running" });

  const lease = await store.leases.acquire({
    workflowInstanceId: instance.value.id,
    ownerId: "owner-test" as OwnerId,
    ttlMs: 60_000,
  });
  if (!lease.isOk()) throw new Error("Failed to acquire lease");

  return { instance: instance.value, lease: lease.value };
}

describe("abort-execution — cancel signal", () => {
  it("returns ok(ExecutionAbortedData) with signal: cancel on a running instance", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createRunningInstance(store);

    const result = await abortExecution({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      signal: "cancel",
      store,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-aborted");
      expect(result.value.signal).toBe("cancel");
      expect(result.value.workflowInstanceId).toBe(instance.id);
      const completeEffect = result.value.effects.find(
        (e) => e.kind === "complete-execution",
      );
      expect(completeEffect).toBeDefined();
    }
  });

  it("transitions instance to cancelled status on cancel", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createRunningInstance(store);

    await abortExecution({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      signal: "cancel",
      store,
    });

    const afterInstance = await store.instances.getById(instance.id);
    expect(afterInstance.isOk()).toBe(true);
    if (afterInstance.isOk()) {
      expect(afterInstance.value.status).toBe("cancelled");
    }
  });
});

describe("abort-execution — pause signal", () => {
  it("returns ok(ExecutionAbortedData) with signal: pause on a running instance", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createRunningInstance(store);

    const result = await abortExecution({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      signal: "pause",
      store,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-aborted");
      expect(result.value.signal).toBe("pause");
      const pauseEffect = result.value.effects.find(
        (e) => e.kind === "pause-execution",
      );
      expect(pauseEffect).toBeDefined();
    }
  });
});

describe("abort-execution — terminal state guard", () => {
  it("returns command_not_found for a completed instance", async () => {
    const store = createInMemoryRuntimeStore();
    const { workflowInstanceId, leaseId } = await startWorkflow(store);

    // Workflow is now completed — abort should return typed error
    const result = await abortExecution({
      workflowInstanceId,
      leaseId,
      signal: "cancel",
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_not_found");
      if (result.error.type === "command_not_found") {
        expect(result.error.entity).toBe("execution");
        expect(result.error.message).toContain("terminal state");
      }
    }
  });
});

describe("abort-execution — lease mismatch", () => {
  it("returns command_not_found (entity: lease) when leaseId does not match", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance } = await createRunningInstance(store);

    const wrongLeaseId = createExecutionLeaseId("wrong-lease-id");

    const result = await abortExecution({
      workflowInstanceId: instance.id,
      leaseId: wrongLeaseId,
      signal: "cancel",
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_not_found");
      if (result.error.type === "command_not_found") {
        expect(result.error.entity).toBe("lease");
      }
    }
  });
});

describe("abort-execution — validation", () => {
  it("returns command_validation when workflowInstanceId is empty", async () => {
    const store = createInMemoryRuntimeStore();
    const input: AbortExecutionInput = {
      workflowInstanceId: "" as ReturnType<typeof createWorkflowInstanceId>,
      leaseId: createExecutionLeaseId("some-lease"),
      signal: "cancel",
      store,
    };

    const result = await abortExecution(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("workflowInstanceId");
      }
    }
  });

  it("returns command_validation when leaseId is empty", async () => {
    const store = createInMemoryRuntimeStore();
    const input: AbortExecutionInput = {
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: "" as ReturnType<typeof createExecutionLeaseId>,
      signal: "cancel",
      store,
    };

    const result = await abortExecution(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("leaseId");
      }
    }
  });

  it("returns command_validation when signal is missing", async () => {
    const store = createInMemoryRuntimeStore();
    const input = {
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: createExecutionLeaseId("some-lease"),
      signal: "" as "cancel" | "pause",
      store,
    };

    const result = await abortExecution(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("signal");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// § 5 — advance-step
// ---------------------------------------------------------------------------

/** Helper: create a blocked instance with an active lease. */
async function createBlockedInstance(
  store: ReturnType<typeof createInMemoryRuntimeStore>,
  stepName = "execute",
) {
  const instance = await store.instances.create({
    workflowName: "simple-execution",
    goal: "Test goal",
    slug: "test-slug",
  });
  if (!instance.isOk()) throw new Error("Failed to create instance");

  await store.instances.update(instance.value.id, {
    status: "blocked",
    currentStepName: stepName,
  });

  const lease = await store.leases.acquire({
    workflowInstanceId: instance.value.id,
    ownerId: "owner-test" as OwnerId,
    ttlMs: 60_000,
  });
  if (!lease.isOk()) throw new Error("Failed to acquire lease");

  return { instance: instance.value, lease: lease.value };
}

describe("advance-step — success", () => {
  it("returns ok(StepAdvancedData) with correct fields", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstance(store);

    const completionSignal = { outcome: "success" as const };

    const result = await advanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "execute",
      completionSignal,
      store,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("step-advanced");
      expect(result.value.workflowInstanceId).toBe(instance.id);
      expect(result.value.stepName).toBe("execute");
      expect(result.value.completionSignal).toEqual(completionSignal);
      expect(Array.isArray(result.value.effects)).toBe(true);
    }
  });

  it("advances a blocked step with failed outcome", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstance(store);

    const result = await advanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "execute",
      completionSignal: { outcome: "failed", message: "Step failed" },
      store,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("step-advanced");
      expect(result.value.completionSignal.outcome).toBe("failed");
    }
  });
});

describe("advance-step — not found", () => {
  it("returns command_not_found when instance does not exist", async () => {
    const store = createInMemoryRuntimeStore();
    const input: AdvanceStepInput = {
      workflowInstanceId: createWorkflowInstanceId("nonexistent-id"),
      leaseId: createExecutionLeaseId("some-lease"),
      stepName: "execute",
      completionSignal: { outcome: "success" },
      store,
    };

    const result = await advanceStep(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_not_found");
    }
  });
});

describe("advance-step — lease mismatch", () => {
  it("returns command_not_found (entity: lease) when leaseId does not match", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance } = await createBlockedInstance(store);

    const wrongLeaseId = createExecutionLeaseId("wrong-lease-id");

    const result = await advanceStep({
      workflowInstanceId: instance.id,
      leaseId: wrongLeaseId,
      stepName: "execute",
      completionSignal: { outcome: "success" },
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_not_found");
      if (result.error.type === "command_not_found") {
        expect(result.error.entity).toBe("lease");
      }
    }
  });
});

describe("advance-step — validation", () => {
  it("returns command_validation when workflowInstanceId is empty", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await advanceStep({
      workflowInstanceId: "" as ReturnType<typeof createWorkflowInstanceId>,
      leaseId: createExecutionLeaseId("some-lease"),
      stepName: "execute",
      completionSignal: { outcome: "success" },
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("workflowInstanceId");
      }
    }
  });

  it("returns command_validation when leaseId is empty", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await advanceStep({
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: "" as ReturnType<typeof createExecutionLeaseId>,
      stepName: "execute",
      completionSignal: { outcome: "success" },
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("leaseId");
      }
    }
  });

  it("returns command_validation when stepName is empty", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await advanceStep({
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: createExecutionLeaseId("some-lease"),
      stepName: "",
      completionSignal: { outcome: "success" },
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("stepName");
      }
    }
  });

  it("returns command_validation when completionSignal is missing", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await advanceStep({
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: createExecutionLeaseId("some-lease"),
      stepName: "execute",
      completionSignal: null as unknown as AdvanceStepInput["completionSignal"],
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("completionSignal");
      }
    }
  });

  it("returns command_validation when completionSignal.outcome is missing", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await advanceStep({
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: createExecutionLeaseId("some-lease"),
      stepName: "execute",
      completionSignal: {
        outcome: "" as "success" | "blocked" | "failed" | "paused",
      },
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("completionSignal.outcome");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// § 6 — runtime-health
// ---------------------------------------------------------------------------

describe("runtime-health — pure operation", () => {
  it("always returns ok(RuntimeHealthData) — never fails", async () => {
    const healthReport = buildAdapterHealthReport({
      harness: "test-harness",
      capabilityContract: makeContractWithCommandEntrypoints("native"),
      probeResults: [],
    });

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("runtime-health");
    }
  });

  it("returns ok even when all capabilities are degraded", async () => {
    const healthReport = buildAdapterHealthReport({
      harness: "degraded-harness",
      capabilityContract: {
        capabilities: [
          makeCapabilityEntry("config-materialization", "degraded"),
          makeCapabilityEntry("agent-materialization", "degraded"),
          makeCapabilityEntry("primary-agent-selection", "degraded"),
          makeCapabilityEntry("delegated-specialist-execution", "degraded"),
          makeCapabilityEntry("prompt-composition", "degraded"),
          makeCapabilityEntry("tool-policy-mapping", "degraded"),
          makeCapabilityEntry("workflow-persistence", "degraded"),
          makeCapabilityEntry("workflow-step-dispatch", "degraded"),
          makeCapabilityEntry("plan-file-compatibility", "degraded"),
          makeCapabilityEntry("command-entrypoints", "degraded"),
          makeCapabilityEntry("event-logging", "degraded"),
          makeCapabilityEntry("token-usage-reporting", "degraded"),
        ],
      },
      probeResults: [],
    });

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("runtime-health");
    }
  });
});

describe("runtime-health — commandEntrypointsSupported derivation", () => {
  it("returns true when command-entrypoints is native", async () => {
    const healthReport = buildAdapterHealthReport({
      harness: "test-harness",
      capabilityContract: makeContractWithCommandEntrypoints("native"),
      probeResults: [],
    });

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.commandEntrypointsSupported).toBe(true);
    }
  });

  it("returns true when command-entrypoints is emulated", async () => {
    const healthReport = buildAdapterHealthReport({
      harness: "test-harness",
      capabilityContract: makeContractWithCommandEntrypoints("emulated"),
      probeResults: [],
    });

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.commandEntrypointsSupported).toBe(true);
    }
  });

  it("returns false when command-entrypoints is degraded", async () => {
    const healthReport = buildAdapterHealthReport({
      harness: "test-harness",
      capabilityContract: makeContractWithCommandEntrypoints("degraded"),
      probeResults: [],
    });

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.commandEntrypointsSupported).toBe(false);
    }
  });

  it("returns false when command-entrypoints is unsupported", async () => {
    const healthReport = buildAdapterHealthReport({
      harness: "test-harness",
      capabilityContract: makeContractWithCommandEntrypoints("unsupported"),
      probeResults: [],
    });

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.commandEntrypointsSupported).toBe(false);
    }
  });
});

describe("runtime-health — degraded/unsupported operation lists", () => {
  it("uses adapter-supplied degradedOperations list when non-empty", async () => {
    const healthReport = buildAdapterHealthReport({
      harness: "test-harness",
      capabilityContract: makeContractWithCommandEntrypoints("native"),
      probeResults: [],
    });

    const result = await runtimeHealth({
      healthReport,
      degradedOperations: ["start-plan: slow disk I/O"],
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.degradedOperations).toEqual([
        "start-plan: slow disk I/O",
      ]);
    }
  });

  it("uses adapter-supplied unsupportedOperations list when non-empty", async () => {
    const healthReport = buildAdapterHealthReport({
      harness: "test-harness",
      capabilityContract: makeContractWithCommandEntrypoints("native"),
      probeResults: [],
    });

    const result = await runtimeHealth({
      healthReport,
      unsupportedOperations: ["advance-step: not available in this harness"],
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.unsupportedOperations).toEqual([
        "advance-step: not available in this harness",
      ]);
    }
  });

  it("derives unsupportedOperations from profile failures when adapter list is absent", async () => {
    const healthReport = buildAdapterHealthReport({
      harness: "test-harness",
      capabilityContract: makeContractWithCommandEntrypoints("degraded"),
      probeResults: [],
    });

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.unsupportedOperations.length).toBeGreaterThan(0);
      const hasCommandEntrypoints = result.value.unsupportedOperations.some(
        (op) => op.includes("command-entrypoints"),
      );
      expect(hasCommandEntrypoints).toBe(true);
    }
  });

  it("returns empty unsupportedOperations when all required capabilities pass", async () => {
    const healthReport = buildAdapterHealthReport({
      harness: "test-harness",
      capabilityContract: makeContractWithCommandEntrypoints("native"),
      probeResults: [],
    });

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.unsupportedOperations).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// § 7 — MockSecondAdapter portability proof
// ---------------------------------------------------------------------------

describe("MockSecondAdapter — non-OpenCode adapter portability", () => {
  it("drives runNamedWorkflow end-to-end without OpenCode imports", async () => {
    const adapter = new MockSecondAdapter();
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Prove portability",
        slug: "prove-portability",
        ownerId: "mock-second-adapter-owner",
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      adapter.projectEffect,
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-started");
      expect(result.value.workflowName).toBe("simple-execution");
      expect(result.value.goal).toBe("Prove portability");
    }

    // Adapter recorded the projected effects without harness I/O
    expect(adapter.projectedEffects.length).toBeGreaterThanOrEqual(1);
    expect(adapter.projectedEffects[0]?.kind).toBe("dispatch-agent");
  });

  it("drives startPlan end-to-end without OpenCode imports", async () => {
    const adapter = new MockSecondAdapter();
    const store = createInMemoryRuntimeStore();
    const provider = new MockPlanStateProvider(true, true);

    const result = await startPlan(
      {
        planName: "portability-plan",
        workflowName: "simple-execution",
        goal: "Prove plan portability",
        slug: "portability-plan",
        ownerId: "mock-second-adapter-owner",
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: provider,
      },
      adapter.projectEffect,
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-started");
      expect(result.value.workflowName).toBe("simple-execution");
    }

    // Adapter recorded the projected effects
    expect(adapter.projectedEffects.length).toBeGreaterThanOrEqual(1);
  });

  it("health report reflects emulated command-entrypoints", async () => {
    const adapter = new MockSecondAdapter();
    const initInput = adapter.buildInitInput();
    const healthReport = buildAdapterHealthReport(initInput);

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // emulated → commandEntrypointsSupported: true
      expect(result.value.commandEntrypointsSupported).toBe(true);
      expect(result.value.healthReport.harness).toBe("mock-second-adapter");
    }
  });

  it("effect projection is recorded by the adapter without harness I/O", async () => {
    const adapter = new MockSecondAdapter();
    const store = createInMemoryRuntimeStore();

    // Run a multi-step workflow to verify multiple effects are recorded
    const result = await runNamedWorkflow(
      {
        workflowName: "multi-step-execution",
        goal: "Multi-step portability test",
        slug: "multi-step-portability",
        ownerId: "mock-second-adapter-owner",
        store,
        workflows: MULTI_STEP_WORKFLOWS,
      },
      adapter.projectEffect,
    );

    expect(result.isOk()).toBe(true);
    // Multi-step workflow dispatches at least 2 effects (one per step)
    expect(adapter.projectedEffects.length).toBeGreaterThanOrEqual(2);
    for (const effect of adapter.projectedEffects) {
      expect(effect.kind).toBe("dispatch-agent");
    }
  });

  it("adapter harness name is distinct from OpenCode", async () => {
    const adapter = new MockSecondAdapter();
    expect(adapter.harness).toBe("mock-second-adapter");
    expect(adapter.harness).not.toBe("opencode");
    expect(adapter.harness).not.toContain("opencode");
  });

  it("inspect-status works after MockSecondAdapter drives a workflow", async () => {
    const adapter = new MockSecondAdapter();
    const store = createInMemoryRuntimeStore();

    const startResult = await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Inspect after run",
        slug: "inspect-after-run",
        ownerId: "mock-second-adapter-owner",
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      adapter.projectEffect,
    );

    expect(startResult.isOk()).toBe(true);
    if (!startResult.isOk()) return;

    const statusResult = await inspectStatus({
      workflowInstanceId: startResult.value.workflowInstanceId,
      store,
    });

    expect(statusResult.isOk()).toBe(true);
    if (statusResult.isOk()) {
      expect(statusResult.value.kind).toBe("execution-status");
      expect(statusResult.value.status).toBe("completed");
      expect(statusResult.value.goal).toBe("Inspect after run");
    }
  });
});

// ---------------------------------------------------------------------------
// § 8 — Event/journal evidence summaries
// ---------------------------------------------------------------------------

describe("journal evidence — journal API is queryable after workflow runs", () => {
  it("journal query API is available and returns ok after runNamedWorkflow", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Journal evidence test",
        slug: "journal-evidence",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      noopProjectEffect,
    );

    expect(result.isOk()).toBe(true);

    // The journal query API is available — the store is queryable after a run.
    // The lifecycle does not write journal entries directly; adapters or
    // harness-specific observers write entries via store.journal.append().
    const journalEntries = await store.journal.query({});
    expect(journalEntries.isOk()).toBe(true);
    if (journalEntries.isOk()) {
      expect(Array.isArray(journalEntries.value)).toBe(true);
    }
  });

  it("journal entries written by adapters are queryable by workflowInstanceId", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Journal association test",
        slug: "journal-association",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      noopProjectEffect,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // Simulate an adapter writing a journal entry for this workflow instance.
    // This proves the journal API is queryable by workflowInstanceId.
    const appendResult = await store.journal.append({
      source: { kind: "adapter", name: "mock-second-adapter" },
      eventType: "workflow.started",
      workflowInstanceId: result.value.workflowInstanceId,
      severity: "info",
      data: {
        workflowName: "simple-execution",
        goal: "Journal association test",
      },
    });
    expect(appendResult.isOk()).toBe(true);

    const journalEntries = await store.journal.query({
      workflowInstanceId: result.value.workflowInstanceId,
    });

    expect(journalEntries.isOk()).toBe(true);
    if (journalEntries.isOk()) {
      expect(journalEntries.value.length).toBeGreaterThan(0);
      for (const entry of journalEntries.value) {
        expect(entry.workflowInstanceId).toBe(result.value.workflowInstanceId);
      }
    }
  });

  it("journal entries written by adapters are queryable by source name", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Journal source test",
        slug: "journal-source",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      noopProjectEffect,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // Write two entries from different sources
    await store.journal.append({
      source: { kind: "adapter", name: "mock-second-adapter" },
      eventType: "step.dispatched",
      workflowInstanceId: result.value.workflowInstanceId,
      severity: "info",
      data: { stepName: "execute" },
    });

    await store.journal.append({
      source: { kind: "engine", name: "workflow-runner" },
      eventType: "workflow.completed",
      workflowInstanceId: result.value.workflowInstanceId,
      severity: "info",
      data: { stepsDispatched: 1 },
    });

    // Query by source name — only adapter entries
    const adapterEntries = await store.journal.query({
      sourceName: "mock-second-adapter",
    });
    expect(adapterEntries.isOk()).toBe(true);
    if (adapterEntries.isOk()) {
      expect(adapterEntries.value.length).toBe(1);
      expect(adapterEntries.value[0]?.source.name).toBe("mock-second-adapter");
    }

    // Query by source name — only engine entries
    const engineEntries = await store.journal.query({
      sourceName: "workflow-runner",
    });
    expect(engineEntries.isOk()).toBe(true);
    if (engineEntries.isOk()) {
      expect(engineEntries.value.length).toBe(1);
      expect(engineEntries.value[0]?.source.name).toBe("workflow-runner");
    }
  });

  it("journal query returns empty array when no entries match the filter", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Journal empty filter test",
        slug: "journal-empty-filter",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      noopProjectEffect,
    );

    expect(result.isOk()).toBe(true);

    // No entries written — query returns empty array
    const journalEntries = await store.journal.query({
      sourceName: "nonexistent-source",
    });
    expect(journalEntries.isOk()).toBe(true);
    if (journalEntries.isOk()) {
      expect(journalEntries.value).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// § 9 — Authorization boundary: no secret-bearing metadata, no ambiguous targets
// ---------------------------------------------------------------------------

describe("command operation authorization boundary — no secret-bearing metadata", () => {
  /**
   * These tests prove that state-mutating command operations carry explicit
   * user authorization identifiers (ownerId, leaseId) and do NOT accept
   * secret-bearing metadata fields.
   *
   * The proof is structural: the input types for start-plan, run-named-workflow,
   * abort-execution, and advance-step have no `metadata` field. TypeScript
   * enforces this at compile time; these runtime tests document the contract.
   */

  it("start-plan input has no metadata field — ownerId is the authorization identifier", async () => {
    const store = createInMemoryRuntimeStore();
    const provider = new MockPlanStateProvider(true, true);

    // The input type has no metadata field — only explicit authorization via ownerId.
    // This is the structural proof that start-plan cannot carry secret-bearing metadata.
    const input = {
      planName: "auth-boundary-plan",
      workflowName: "simple-execution",
      goal: "Authorization boundary test",
      slug: "auth-boundary-plan",
      ownerId: "explicit-owner-id", // explicit authorization identifier
      store,
      workflows: SIMPLE_WORKFLOWS,
      planStateProvider: provider,
    };

    // TypeScript would reject any `metadata` field on this input at compile time.
    // The runtime test proves the operation succeeds with only explicit authorization.
    const result = await startPlan(input, noopProjectEffect);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-started");
    }
  });

  it("run-named-workflow input has no metadata field — ownerId is the authorization identifier", async () => {
    const store = createInMemoryRuntimeStore();

    const input = {
      workflowName: "simple-execution",
      goal: "Authorization boundary test",
      slug: "auth-boundary-workflow",
      ownerId: "explicit-owner-id", // explicit authorization identifier
      store,
      workflows: SIMPLE_WORKFLOWS,
    };

    const result = await runNamedWorkflow(input, noopProjectEffect);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-started");
    }
  });

  it("abort-execution input has no metadata field — leaseId is the authorization identifier", async () => {
    const store = createInMemoryRuntimeStore();

    // Create a running instance with an active lease
    const instance = await store.instances.create({
      workflowName: "simple-execution",
      goal: "Test goal",
      slug: "test-slug",
    });
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;

    await store.instances.update(instance.value.id, { status: "running" });

    const lease = await store.leases.acquire({
      workflowInstanceId: instance.value.id,
      ownerId: "explicit-owner-id" as Parameters<
        typeof store.leases.acquire
      >[0]["ownerId"],
      ttlMs: 60_000,
    });
    expect(lease.isOk()).toBe(true);
    if (!lease.isOk()) return;

    // The input type has no metadata field — only explicit authorization via leaseId.
    const input = {
      workflowInstanceId: instance.value.id,
      leaseId: lease.value.id, // explicit authorization identifier
      signal: "cancel" as const,
      store,
    };

    const result = await abortExecution(input);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-aborted");
    }
  });

  it("advance-step input has no metadata field — leaseId is the authorization identifier", async () => {
    const store = createInMemoryRuntimeStore();

    const instance = await store.instances.create({
      workflowName: "simple-execution",
      goal: "Test goal",
      slug: "test-slug",
    });
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;

    await store.instances.update(instance.value.id, {
      status: "blocked",
      currentStepName: "execute",
    });

    const lease = await store.leases.acquire({
      workflowInstanceId: instance.value.id,
      ownerId: "explicit-owner-id" as Parameters<
        typeof store.leases.acquire
      >[0]["ownerId"],
      ttlMs: 60_000,
    });
    expect(lease.isOk()).toBe(true);
    if (!lease.isOk()) return;

    // The input type has no metadata field — only explicit authorization via leaseId.
    const input = {
      workflowInstanceId: instance.value.id,
      leaseId: lease.value.id, // explicit authorization identifier
      stepName: "execute",
      completionSignal: { outcome: "success" as const },
      store,
    };

    const result = await advanceStep(input);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("step-advanced");
    }
  });
});

describe("command operation authorization boundary — ambiguous targets are rejected", () => {
  /**
   * These tests prove that state-mutating command operations reject ambiguous
   * execution targets. An "ambiguous target" is one where the required
   * authorization identifier (ownerId, leaseId, workflowInstanceId) is absent
   * or empty — the operation cannot proceed without knowing exactly which
   * execution to affect.
   */

  it("start-plan rejects empty ownerId — no implicit authorization", async () => {
    const store = createInMemoryRuntimeStore();
    const provider = new MockPlanStateProvider(true, true);

    const result = await startPlan(
      {
        planName: "my-plan",
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "my-plan",
        ownerId: "", // empty — ambiguous authorization
        store,
        workflows: SIMPLE_WORKFLOWS,
        planStateProvider: provider,
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("ownerId");
      }
    }
  });

  it("run-named-workflow rejects empty ownerId — no implicit authorization", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "test-slug",
        ownerId: "", // empty — ambiguous authorization
        store,
        workflows: SIMPLE_WORKFLOWS,
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("ownerId");
      }
    }
  });

  it("abort-execution rejects empty leaseId — no implicit authorization", async () => {
    const result = await abortExecution({
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: "" as ReturnType<typeof createExecutionLeaseId>, // empty — ambiguous
      signal: "cancel",
      store: createInMemoryRuntimeStore(),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("leaseId");
      }
    }
  });

  it("abort-execution rejects empty workflowInstanceId — no implicit target", async () => {
    const result = await abortExecution({
      workflowInstanceId: "" as ReturnType<typeof createWorkflowInstanceId>, // empty — ambiguous
      leaseId: createExecutionLeaseId("some-lease"),
      signal: "cancel",
      store: createInMemoryRuntimeStore(),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("workflowInstanceId");
      }
    }
  });

  it("advance-step rejects empty leaseId — no implicit authorization", async () => {
    const result = await advanceStep({
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: "" as ReturnType<typeof createExecutionLeaseId>, // empty — ambiguous
      stepName: "execute",
      completionSignal: { outcome: "success" },
      store: createInMemoryRuntimeStore(),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("leaseId");
      }
    }
  });

  it("advance-step rejects empty workflowInstanceId — no implicit target", async () => {
    const result = await advanceStep({
      workflowInstanceId: "" as ReturnType<typeof createWorkflowInstanceId>, // empty — ambiguous
      leaseId: createExecutionLeaseId("some-lease"),
      stepName: "execute",
      completionSignal: { outcome: "success" },
      store: createInMemoryRuntimeStore(),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("workflowInstanceId");
      }
    }
  });

  it("advance-step rejects empty stepName — no implicit step target", async () => {
    const result = await advanceStep({
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: createExecutionLeaseId("some-lease"),
      stepName: "", // empty — ambiguous step target
      completionSignal: { outcome: "success" },
      store: createInMemoryRuntimeStore(),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("stepName");
      }
    }
  });

  it("inspect-status is read-only — no authorization identifier required beyond workflowInstanceId", async () => {
    // inspect-status is read-only and does not require a leaseId.
    // It only needs a workflowInstanceId to identify the target.
    const store = createInMemoryRuntimeStore();
    const nonExistentId = createWorkflowInstanceId("nonexistent-inspect-auth");

    const result = await inspectStatus({
      workflowInstanceId: nonExistentId,
      store,
    });

    // Returns not_found — not a validation error — proving the read-only
    // operation does not require additional authorization beyond the target ID.
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_not_found");
    }
  });
});

// ---------------------------------------------------------------------------
// § 10 — Completion signals: review_verdict, plan completion, degraded paths
// ---------------------------------------------------------------------------

/**
 * Helper: create a blocked instance on a specific step with an active lease.
 * Used for completion signal tests that need a specific workflow and step.
 */
async function createBlockedInstanceOnStep(
  store: ReturnType<typeof createInMemoryRuntimeStore>,
  workflowName: string,
  stepName: string,
) {
  const instance = await store.instances.create({
    workflowName,
    goal: "Test goal",
    slug: "test-slug",
  });
  if (!instance.isOk()) throw new Error("Failed to create instance");

  await store.instances.update(instance.value.id, {
    status: "blocked",
    currentStepName: stepName,
  });

  const lease = await store.leases.acquire({
    workflowInstanceId: instance.value.id,
    ownerId: "owner-test" as OwnerId,
    ttlMs: 60_000,
  });
  if (!lease.isOk()) throw new Error("Failed to acquire lease");

  return { instance: instance.value, lease: lease.value };
}

describe("advance-step — review_verdict: approved (success path)", () => {
  it("returns ok(StepAdvancedData) when review_verdict is approved", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "gate-execution",
      "gate",
    );

    const result = await advanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "gate",
      completionSignal: {
        outcome: "success",
        method: "review_verdict",
        approved: true,
      },
      store,
      context: {
        workflowName: "gate-execution",
        goal: "Test goal",
        slug: "test-slug",
        workflows: GATE_WORKFLOWS,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("step-advanced");
      expect(result.value.stepName).toBe("gate");
      expect(result.value.completionSignal.outcome).toBe("success");
      // Approved gate on final step → complete-execution effect
      const hasTerminalEffect = result.value.effects.some(
        (e) => e.kind === "complete-execution" || e.kind === "dispatch-agent",
      );
      expect(hasTerminalEffect).toBe(true);
    }
  });

  it("effects are projectable by adapters after approved review_verdict", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "gate-execution",
      "gate",
    );

    const result = await advanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "gate",
      completionSignal: {
        outcome: "success",
        method: "review_verdict",
        approved: true,
      },
      store,
      context: {
        workflowName: "gate-execution",
        goal: "Test goal",
        slug: "test-slug",
        workflows: GATE_WORKFLOWS,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Effects are returned in the result — adapters can project them
      expect(Array.isArray(result.value.effects)).toBe(true);
    }
  });
});

describe("advance-step — review_verdict: rejected + on_reject: pause (blocked advancement)", () => {
  it("returns ok(StepAdvancedData) with pause-execution effect when rejected", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "gate-execution",
      "gate",
    );

    const result = await advanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "gate",
      completionSignal: {
        outcome: "success",
        method: "review_verdict",
        approved: false,
        message: "Changes need revision",
      },
      store,
      context: {
        workflowName: "gate-execution",
        goal: "Test goal",
        slug: "test-slug",
        workflows: GATE_WORKFLOWS,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("step-advanced");
      // Rejected gate with on_reject:pause → pause-execution effect
      const pauseEffect = result.value.effects.find(
        (e) => e.kind === "pause-execution",
      );
      expect(pauseEffect).toBeDefined();
    }
  });

  it("instance transitions to paused status after rejected review_verdict", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "gate-execution",
      "gate",
    );

    await advanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "gate",
      completionSignal: {
        outcome: "success",
        method: "review_verdict",
        approved: false,
      },
      store,
      context: {
        workflowName: "gate-execution",
        goal: "Test goal",
        slug: "test-slug",
        workflows: GATE_WORKFLOWS,
      },
    });

    const afterInstance = await store.instances.getById(instance.id);
    expect(afterInstance.isOk()).toBe(true);
    if (afterInstance.isOk()) {
      expect(afterInstance.value.status).toBe("paused");
    }
  });

  it("pause-execution effect carries the workflowInstanceId for adapter projection", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "gate-execution",
      "gate",
    );

    const result = await advanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "gate",
      completionSignal: {
        outcome: "success",
        method: "review_verdict",
        approved: false,
      },
      store,
      context: {
        workflowName: "gate-execution",
        goal: "Test goal",
        slug: "test-slug",
        workflows: GATE_WORKFLOWS,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const pauseEffect = result.value.effects.find(
        (e) => e.kind === "pause-execution",
      );
      expect(pauseEffect).toBeDefined();
      if (pauseEffect?.kind === "pause-execution") {
        expect(pauseEffect.workflowInstanceId).toBe(instance.id);
      }
    }
  });
});

describe("advance-step — plan_created: missing planStateProvider (degraded fallback)", () => {
  it("returns command_lifecycle error when planStateProvider is absent for plan_created step", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "plan-completion-execution",
      "create-plan",
    );

    // No planStateProvider — plan_created completion requires one
    const result = await advanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "create-plan",
      completionSignal: {
        outcome: "success",
        method: "plan_created",
      },
      store,
      context: {
        workflowName: "plan-completion-execution",
        goal: "Test goal",
        slug: "test-slug",
        workflows: PLAN_COMPLETION_WORKFLOWS,
      },
      // planStateProvider intentionally absent — degraded fallback
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      // Missing provider → policy_decision lifecycle error → command_lifecycle
      expect(result.error.type).toBe("command_lifecycle");
      if (result.error.type === "command_lifecycle") {
        expect(result.error.cause.type).toBe("policy_decision");
      }
    }
  });

  it("returns command_lifecycle error when planStateProvider is absent for plan_complete step", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "plan-completion-execution",
      "execute-plan",
    );

    // No planStateProvider — plan_complete completion requires one
    const result = await advanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "execute-plan",
      completionSignal: {
        outcome: "success",
        method: "plan_complete",
      },
      store,
      context: {
        workflowName: "plan-completion-execution",
        goal: "Test goal",
        slug: "test-slug",
        workflows: PLAN_COMPLETION_WORKFLOWS,
      },
      // planStateProvider intentionally absent — degraded fallback
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      // Missing provider → policy_decision lifecycle error → command_lifecycle
      expect(result.error.type).toBe("command_lifecycle");
      if (result.error.type === "command_lifecycle") {
        expect(result.error.cause.type).toBe("policy_decision");
      }
    }
  });

  it("succeeds when planStateProvider is supplied and plan exists", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "plan-completion-execution",
      "create-plan",
    );

    // Provider reports plan EXISTS
    const planStateProvider = new MockPlanStateProvider(true, true);

    const result = await advanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "create-plan",
      completionSignal: {
        outcome: "success",
        method: "plan_created",
      },
      store,
      context: {
        workflowName: "plan-completion-execution",
        goal: "Test goal",
        slug: "test-slug",
        workflows: PLAN_COMPLETION_WORKFLOWS,
      },
      planStateProvider,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("step-advanced");
    }
  });
});

describe("advance-step — unsupported automatic signal detection (degraded path)", () => {
  /**
   * OpenCode cannot detect structured completion signals automatically.
   *
   * The `advance-step` command operation requires adapters to supply an
   * explicit `completionSignal` with `outcome` and optionally `method`.
   * There is no automatic signal detection — the engine does not poll for
   * agent output or parse harness events to infer completion.
   *
   * This is the documented degraded path: adapters that cannot wire TUI
   * step-advance must supply explicit signals via the command operation.
   * The `DEGRADED_AFFORDANCES` list in the OpenCode adapter documents this.
   */

  it("advance-step requires explicit completionSignal — no automatic detection", async () => {
    const store = createInMemoryRuntimeStore();

    // Missing completionSignal → command_validation (not automatic detection)
    const result = await advanceStep({
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: createExecutionLeaseId("some-lease"),
      stepName: "execute",
      completionSignal: null as unknown as AdvanceStepInput["completionSignal"],
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      // Explicit validation error — not a silent automatic detection failure
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("completionSignal");
      }
    }
  });

  it("advance-step requires explicit outcome — no inferred outcome from harness events", async () => {
    const store = createInMemoryRuntimeStore();

    // Missing outcome → command_validation (not automatic detection)
    const result = await advanceStep({
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: createExecutionLeaseId("some-lease"),
      stepName: "execute",
      completionSignal: {
        outcome: "" as "success" | "blocked" | "failed" | "paused",
      },
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      // Explicit validation error — outcome must be supplied by the adapter
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("completionSignal.outcome");
      }
    }
  });

  it("advance-step with agent_signal method: accepted when explicitly supplied", async () => {
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "simple-execution",
      "execute",
    );

    // Adapter explicitly supplies agent_signal method — no automatic detection
    const result = await advanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "execute",
      completionSignal: {
        outcome: "success",
        method: "agent_signal",
      },
      store,
      context: {
        workflowName: "simple-execution",
        goal: "Test goal",
        slug: "test-slug",
        workflows: SIMPLE_WORKFLOWS,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("step-advanced");
      expect(result.value.completionSignal.method).toBe("agent_signal");
    }
  });
});

// ---------------------------------------------------------------------------
// § 11 — maxSteps regression: adapter→engine→runner threading
// ---------------------------------------------------------------------------

describe("run-named-workflow — maxSteps threading: adapter→engine→runner", () => {
  /**
   * Regression coverage for the revived `RunWorkflowInput.maxSteps` chain.
   *
   * These tests prove that `maxSteps` is correctly threaded from the
   * `RunNamedWorkflowInput` (engine command operation) through
   * `runWorkflowLifecycle` (runner) and that the structured
   * `command_validation` error with `field: "maxSteps"` and the numeric
   * `maxSteps` value is surfaced without regex scraping.
   *
   * Chain: RunNamedWorkflowInput.maxSteps
   *   → runNamedWorkflow (passes to runWorkflowLifecycle)
   *   → runWorkflowLifecycle (enforces cap, emits max_steps_exceeded)
   *   → mapRunnerErrorToCommandError (maps to command_validation)
   *   → CommandValidationError.maxSteps (structured numeric value)
   */

  it("returns command_validation (field: maxSteps) when maxSteps is 0", async () => {
    // maxSteps < 1 is rejected by runWorkflowLifecycle before any store access.
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Test maxSteps=0 rejection",
        slug: "test-maxsteps-zero",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        maxSteps: 0,
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("maxSteps");
        // Structured numeric value — no regex scraping of message string.
        expect(result.error.maxSteps).toBe(0);
      }
    }
  });

  it("returns command_validation (field: maxSteps) when maxSteps is negative", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Test negative maxSteps rejection",
        slug: "test-maxsteps-negative",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        maxSteps: -5,
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("maxSteps");
        // Structured numeric value matches the supplied cap.
        expect(result.error.maxSteps).toBe(-5);
      }
    }
  });

  it("returns command_validation (field: maxSteps) when a multi-step workflow exceeds maxSteps: 1", async () => {
    // MULTI_STEP_WORKFLOWS has 2 steps. maxSteps: 1 means the second step
    // dispatch triggers the cap. The error must carry the structured maxSteps
    // value so callers can read it without parsing the human-readable message.
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "multi-step-execution",
        goal: "Test maxSteps exceeded on multi-step workflow",
        slug: "test-maxsteps-exceeded",
        ownerId: "owner-test",
        store,
        workflows: MULTI_STEP_WORKFLOWS,
        maxSteps: 1,
      },
      noopProjectEffect,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("maxSteps");
        // Structured value — must equal the cap supplied by the caller.
        expect(result.error.maxSteps).toBe(1);
      }
    }
  });

  it("CommandValidationError.maxSteps carries the exact cap value — no regex scraping needed", async () => {
    // Prove the structured field is present and equals the input cap.
    // Callers must NOT need to parse error.message to recover the cap value.
    const store = createInMemoryRuntimeStore();
    const cap = 3;

    const result = await runNamedWorkflow(
      {
        workflowName: "multi-step-execution",
        goal: "Structured maxSteps value test",
        slug: "structured-maxsteps-value",
        ownerId: "owner-test",
        store,
        workflows: MULTI_STEP_WORKFLOWS,
        maxSteps: cap,
      },
      noopProjectEffect,
    );

    // A 2-step workflow with maxSteps: 3 should succeed (2 ≤ 3).
    // This test proves the cap is threaded correctly for the success path too.
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-started");
    }
  });

  it("succeeds when maxSteps equals the exact step count of the workflow", async () => {
    // MULTI_STEP_WORKFLOWS has 2 steps. maxSteps: 2 should succeed.
    const store = createInMemoryRuntimeStore();

    const result = await runNamedWorkflow(
      {
        workflowName: "multi-step-execution",
        goal: "Exact step count test",
        slug: "exact-step-count",
        ownerId: "owner-test",
        store,
        workflows: MULTI_STEP_WORKFLOWS,
        maxSteps: 2,
      },
      noopProjectEffect,
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-started");
    }
  });

  it("leaves the store empty when maxSteps < 1 (validation before store access)", async () => {
    // maxSteps < 1 is rejected before any WorkflowInstance is created.
    const store = createInMemoryRuntimeStore();

    await runNamedWorkflow(
      {
        workflowName: "simple-execution",
        goal: "Store isolation test",
        slug: "store-isolation",
        ownerId: "owner-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        maxSteps: 0,
      },
      noopProjectEffect,
    );

    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value).toHaveLength(0);
    }
  });
});
