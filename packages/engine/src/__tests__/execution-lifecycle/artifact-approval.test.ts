/**
 * Tests for terminal-outcomes.ts (approveArtifact) lifecycle module.
 *
 * Verifies:
 * - approveArtifact: lease enforcement, self-approval prohibition, state update
 * - approverAgent required validation
 */

import { describe, expect, it } from "bun:test";
import {
  approveArtifact,
  createArtifactId,
  createExecutionLeaseId,
  createInMemoryRuntimeStore,
  dispatchStep,
  startExecution,
  type WorkflowExecutionContext,
} from "@weave/engine";
import { cfg } from "./fixtures.js";

const WORKFLOW_WITH_OUTPUT = cfg(`
workflow review-flow {
  description "Plan then review"
  version 1

  step plan {
    name "Create plan"
    type autonomous
    agent pattern
    prompt "Create a plan for: {{instance.goal}}"
    completion agent_signal

    outputs [
      { name "plan_path" description "Path to the plan" }
    ]
  }

  step review {
    name "Review plan"
    type gate
    agent weft
    prompt "Review the plan at {{artifacts.plan_path}}"
    completion review_verdict

    inputs [
      { name "plan_path" description "Path to the plan" }
    ]
  }
}
`);

async function createRunningInstance() {
  const store = createInMemoryRuntimeStore();
  const createResult = await store.instances.create({
    workflowName: "review-flow",
    goal: "test goal",
    slug: "test-goal",
  });
  if (!createResult.isOk())
    throw new Error(`Failed to create: ${createResult.error.message}`);
  const instanceId = createResult.value.id;

  const startResult = await startExecution(
    { workflowInstanceId: instanceId, ownerId: "test-owner" },
    store,
  );
  if (!startResult.isOk())
    throw new Error(`Failed to start: ${startResult.error.message}`);

  return { store, instanceId, leaseId: startResult.value.leaseId };
}

describe("approveArtifact", () => {
  it("approves an artifact and updates its approvalState", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    // Add an artifact to the instance
    const addResult = await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      producerAgent: "pattern",
    });
    expect(addResult.isOk()).toBe(true);
    if (!addResult.isOk()) return;
    const artifactId =
      addResult.value.artifacts[addResult.value.artifacts.length - 1].id;

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId,
        approvalState: "approved",
        approverAgent: "weft", // different from producer "pattern"
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const artifact = result.value.instance.artifacts.find(
      (a) => a.id === artifactId,
    );
    expect(artifact?.approvalState).toBe("approved");
  });

  it("rejects self-approval (approverAgent === producerAgent)", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const addResult = await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      producerAgent: "pattern",
    });
    expect(addResult.isOk()).toBe(true);
    if (!addResult.isOk()) return;
    const artifactId =
      addResult.value.artifacts[addResult.value.artifacts.length - 1].id;

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId,
        approvalState: "approved",
        approverAgent: "pattern", // same as producer — self-approval
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("self_approval");
    }
  });

  it("returns validation error when approverAgent is missing", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId: createArtifactId("art-001"),
        approvalState: "approved",
        approverAgent: "", // missing
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("approverAgent");
    }
  });

  it("returns lease_conflict for fabricated lease ID", async () => {
    const { store, instanceId } = await createRunningInstance();

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId: createExecutionLeaseId("fabricated-lease"),
        artifactId: createArtifactId("art-001"),
        approvalState: "approved",
        approverAgent: "weft",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");
  });

  it("returns not_found for non-existent artifact", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId: createArtifactId("non-existent-art"),
        approvalState: "approved",
        approverAgent: "weft",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("ArtifactRef");
    }
  });
});
