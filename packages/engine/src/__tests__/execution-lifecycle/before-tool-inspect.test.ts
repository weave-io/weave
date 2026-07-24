/**
 * Tests for before-tool.ts and inspection.ts lifecycle modules.
 *
 * Verifies:
 * - previewToolPolicy: policy evaluation, capability validation, metadata sanitization
 * - inspectExecution: read-only state query, no side effects
 */

import { describe, expect, it } from "bun:test";
import {
  createArtifactId,
  createInMemoryRuntimeStore,
  createWorkflowInstanceId,
  evaluateEffectiveToolPolicy,
  inspectExecution,
  previewToolPolicy,
  startExecution,
} from "@weaveio/weave-engine";
import { leaseId, wfId } from "./fixtures.js";

const allAllowPolicy = evaluateEffectiveToolPolicy({
  read: "allow",
  write: "allow",
  execute: "allow",
  delegate: "allow",
  network: "allow",
});

const mixedPolicy = evaluateEffectiveToolPolicy({
  read: "allow",
  write: "deny",
  execute: "ask",
  delegate: "deny",
  network: "ask",
});

// ---------------------------------------------------------------------------
// previewToolPolicy
// ---------------------------------------------------------------------------

describe("previewToolPolicy", () => {
  it("returns 'allow' for allowed capability", async () => {
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "read",
      toolName: "read_file",
      effectiveToolPolicy: allAllowPolicy,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("allow");
  });

  it("returns 'deny' for denied capability", async () => {
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "write",
      toolName: "edit_file",
      effectiveToolPolicy: mixedPolicy,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("deny");
  });

  it("returns 'ask' for ask capability", async () => {
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "execute",
      toolName: "bash",
      effectiveToolPolicy: mixedPolicy,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("ask");
  });

  it("returns validation error for missing workflowInstanceId", async () => {
    const result = await previewToolPolicy({
      workflowInstanceId: "" as typeof wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "read",
      toolName: "read_file",
      effectiveToolPolicy: allAllowPolicy,
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("workflowInstanceId");
    }
  });

  it("returns validation error for unrecognized toolCapability", async () => {
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "unknown" as "read",
      toolName: "some-tool",
      effectiveToolPolicy: allAllowPolicy,
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("toolCapability");
    }
  });

  it("rejects metadata with denied key", async () => {
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "read",
      toolName: "read_file",
      effectiveToolPolicy: allAllowPolicy,
      metadata: { token: "secret" } as Record<
        string,
        string | number | boolean
      >,
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("accepts all abstract capability categories", async () => {
    const capabilities: Array<
      "read" | "write" | "execute" | "delegate" | "network"
    > = ["read", "write", "execute", "delegate", "network"];
    for (const toolCapability of capabilities) {
      const result = await previewToolPolicy({
        workflowInstanceId: wfId,
        leaseId,
        agentName: "shuttle",
        toolCapability,
        toolName: `mock-${toolCapability}-tool`,
        effectiveToolPolicy: allAllowPolicy,
      });
      expect(result.isOk()).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// inspectExecution
// ---------------------------------------------------------------------------

describe("inspectExecution", () => {
  it("returns execution state without modifying anything", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("inspect-wf-001");

    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "owner-inspect" },
      store,
    );
    expect(startResult.isOk()).toBe(true);
    if (!startResult.isOk()) return;

    const result = await inspectExecution(
      { workflowInstanceId: instanceId },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const output = result.value;
    expect(output.workflowInstanceId).toBe(instanceId);
    expect(output.status).toBe("running");
    expect(output.hasActiveLease).toBe(true);
    expect(output.artifacts).toHaveLength(0);
  });

  it("returns not_found for non-existent instance", async () => {
    const store = createInMemoryRuntimeStore();
    const nonExistentId = createWorkflowInstanceId("non-existent-inspect");

    const result = await inspectExecution(
      { workflowInstanceId: nonExistentId },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("WorkflowInstance");
    }
  });

  it("returns validation error for missing workflowInstanceId", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await inspectExecution(
      { workflowInstanceId: "" as typeof wfId },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("hasActiveLease is false when no active lease exists", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("inspect-no-lease-001");

    // Create instance without starting execution (no lease)
    await store.instances.create({
      id: instanceId,
      workflowName: "test",
      goal: "test",
      slug: "test",
    });

    const result = await inspectExecution(
      { workflowInstanceId: instanceId },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.hasActiveLease).toBe(false);
  });

  it("does not create instances or acquire leases (read-only boundary)", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("inspect-boundary-001");

    // Inspect a non-existent instance — should return not_found, not create it
    const result = await inspectExecution(
      { workflowInstanceId: instanceId },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");

    // Verify no instance was created
    const findResult = await store.instances.findById(instanceId);
    expect(findResult.isOk()).toBe(true);
    if (!findResult.isOk()) return;
    expect(findResult.value).toBeNull();

    // Verify no lease was acquired
    const leaseResult = await store.leases.findActive();
    expect(leaseResult.isOk()).toBe(true);
    if (!leaseResult.isOk()) return;
    expect(leaseResult.value).toBeNull();
  });

  it("returns an empty stepAttempts list when no step has been dispatched yet", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("inspect-step-attempts-empty");

    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "owner-inspect" },
      store,
    );
    expect(startResult.isOk()).toBe(true);

    const result = await inspectExecution(
      { workflowInstanceId: instanceId },
      store,
    );
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.stepAttempts).toEqual([]);
  });

  it("exposes recorded step attempts and their consumed artifact revisions so adapters can compute retry-safe pins (Spec 22 Unit 3 default retry reuse)", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("inspect-step-attempts-001");

    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "owner-inspect" },
      store,
    );
    expect(startResult.isOk()).toBe(true);

    const artifactId = createArtifactId("artifact-1");
    const firstAttempt = await store.instances.recordStepAttempt(
      instanceId,
      "implement",
      [{ artifactId, name: "spec", revision: 1 }],
    );
    expect(firstAttempt.isOk()).toBe(true);

    const secondAttempt = await store.instances.recordStepAttempt(
      instanceId,
      "implement",
      [{ artifactId, name: "spec", revision: 1 }],
    );
    expect(secondAttempt.isOk()).toBe(true);

    const result = await inspectExecution(
      { workflowInstanceId: instanceId },
      store,
    );
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.stepAttempts).toHaveLength(2);
    expect(result.value.stepAttempts[0]?.attemptNumber).toBe(1);
    expect(result.value.stepAttempts[1]?.attemptNumber).toBe(2);
    for (const attempt of result.value.stepAttempts) {
      expect(attempt.stepName).toBe("implement");
      expect(attempt.consumedArtifacts).toEqual([
        { artifactId, name: "spec", revision: 1 },
      ]);
    }
  });

  it("does not mutate stepAttempts (read-only boundary)", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId(
      "inspect-step-attempts-readonly",
    );

    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "owner-inspect" },
      store,
    );
    expect(startResult.isOk()).toBe(true);

    const recorded = await store.instances.recordStepAttempt(
      instanceId,
      "plan",
      [],
    );
    expect(recorded.isOk()).toBe(true);

    await inspectExecution({ workflowInstanceId: instanceId }, store);
    await inspectExecution({ workflowInstanceId: instanceId }, store);

    const findResult = await store.instances.findById(instanceId);
    expect(findResult.isOk()).toBe(true);
    if (!findResult.isOk()) return;
    expect(findResult.value?.stepAttempts).toHaveLength(1);
  });
});
