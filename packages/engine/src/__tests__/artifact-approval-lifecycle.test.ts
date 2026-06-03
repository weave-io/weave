/**
 * Artifact Approval Lifecycle Tests — Task 3.3
 *
 * Verifies:
 * 1. Approval invalidation: new artifact revisions reset approvalState to
 *    "pending", blocking dispatch of normative inputs until re-approved.
 * 2. Self-approval prohibition: producers cannot approve their own artifacts.
 * 3. Consumed-revision recording: dispatchStep records consumed artifact
 *    identity+revision in stepAttempts.
 * 4. Retry reuse: retries pin to the same consumed artifact revisions from
 *    the prior attempt by default.
 * 5. approveArtifact lifecycle function: validates inputs, enforces self-
 *    approval prohibition, delegates to store.
 *
 * All tests use createInMemoryRuntimeStore — no SQLite, no filesystem.
 */

import { describe, expect, it } from "bun:test";
import { parseConfig } from "@weave/core";
import {
  approveArtifact,
  createArtifactId,
  createExecutionLeaseId,
  createInMemoryRuntimeStore,
  createWorkflowInstanceId,
  dispatchStep,
  startExecution,
  type ConsumedArtifactRecord,
  type WorkflowExecutionContext,
} from "@weave/engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a .weave source string and unwrap — throws on invalid input. */
function cfg(source: string) {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/** Minimal workflow with one step that has a normative artifact input. */
const WORKFLOW_WITH_NORMATIVE_INPUT = cfg(`
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
      { name "plan_path" description "Path to the generated plan file" }
    ]
  }

  step review {
    name "Review the plan"
    type gate
    agent warp
    prompt "Review the plan at {{artifacts.plan_path}}"
    completion review_verdict
    on_reject pause

    inputs [
      { name "plan_path" description "Path to the plan to review" }
    ]
  }
}
`);

/** Minimal workflow with one step and no inputs (for basic dispatch tests). */
const WORKFLOW_NO_INPUTS = cfg(`
workflow simple-flow {
  description "Simple single-step flow"
  version 1

  step work {
    name "Do work"
    type autonomous
    agent shuttle
    prompt "Do the work for: {{instance.goal}}"
    completion agent_signal
  }
}
`);

/** Build a WorkflowExecutionContext from a parsed config. */
function makeContext(
  config: ReturnType<typeof cfg>,
  workflowName: string,
  goal = "test goal",
  slug = "test-goal",
): WorkflowExecutionContext {
  return {
    workflowName,
    goal,
    slug,
    workflows: config.workflows ?? {},
  };
}

/** Create a running instance and return { store, instanceId, leaseId }. */
async function setupRunningInstance(
  workflowName: string,
  config: ReturnType<typeof cfg>,
) {
  const store = createInMemoryRuntimeStore();
  const instanceId = createWorkflowInstanceId(`wf-${workflowName}`);
  const context = makeContext(config, workflowName);

  const startResult = await startExecution(
    {
      workflowInstanceId: instanceId,
      ownerId: "owner-test",
      authorizationSource: "user",
      context,
    },
    store,
  );
  if (startResult.isErr()) {
    throw new Error(`startExecution failed: ${startResult.error.message}`);
  }
  const { leaseId } = startResult.value;
  return { store, instanceId, leaseId };
}

// ---------------------------------------------------------------------------
// 1. approveArtifact — basic validation
// ---------------------------------------------------------------------------

describe("approveArtifact — input validation", () => {
  it("returns validation error when workflowInstanceId is missing", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await approveArtifact(
      {
        workflowInstanceId: "" as ReturnType<typeof createWorkflowInstanceId>,
        leaseId: createExecutionLeaseId("lease-001"),
        artifactId: createArtifactId("art-001"),
        approvalState: "approved",
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("validation");
  });

  it("returns validation error when leaseId is missing", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await approveArtifact(
      {
        workflowInstanceId: createWorkflowInstanceId("wf-001"),
        leaseId: "" as ReturnType<typeof createExecutionLeaseId>,
        artifactId: createArtifactId("art-001"),
        approvalState: "approved",
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("validation");
  });

  it("returns validation error when artifactId is missing", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await approveArtifact(
      {
        workflowInstanceId: createWorkflowInstanceId("wf-001"),
        leaseId: createExecutionLeaseId("lease-001"),
        artifactId: "" as ReturnType<typeof createArtifactId>,
        approvalState: "approved",
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("validation");
  });

  it("returns not_found when workflow instance does not exist", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await approveArtifact(
      {
        workflowInstanceId: createWorkflowInstanceId("nonexistent"),
        leaseId: createExecutionLeaseId("lease-001"),
        artifactId: createArtifactId("art-001"),
        approvalState: "approved",
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
  });

  it("returns not_found when artifact does not exist on instance", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("wf-001");
    await store.instances.create({
      id: instanceId,
      workflowName: "test",
      goal: "test",
      slug: "test",
    });

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId: createExecutionLeaseId("lease-001"),
        artifactId: createArtifactId("nonexistent-art"),
        approvalState: "approved",
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// 2. approveArtifact — self-approval prohibition
// ---------------------------------------------------------------------------

describe("approveArtifact — self-approval prohibition", () => {
  it("rejects approval when approverAgent matches producerAgent", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("wf-self-approve");
    await store.instances.create({
      id: instanceId,
      workflowName: "test",
      goal: "test",
      slug: "test",
    });

    // Add artifact with producerAgent = "shuttle"
    const withArtifact = (
      await store.instances.addArtifact(instanceId, {
        name: "plan",
        path: ".weave/plans/test.md",
        producerAgent: "shuttle",
      })
    )._unsafeUnwrap();

    const artifactId = withArtifact.artifacts[0].id;

    // Attempt self-approval: approverAgent === producerAgent
    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId: createExecutionLeaseId("lease-001"),
        artifactId,
        approvalState: "approved",
        approverAgent: "shuttle",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("policy_decision");
    expect(error.message).toContain("shuttle");
    expect(error.message.toLowerCase()).toContain("self-approval");
  });

  it("allows approval when approverAgent differs from producerAgent", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("wf-cross-approve");
    await store.instances.create({
      id: instanceId,
      workflowName: "test",
      goal: "test",
      slug: "test",
    });

    const withArtifact = (
      await store.instances.addArtifact(instanceId, {
        name: "plan",
        path: ".weave/plans/test.md",
        producerAgent: "shuttle",
      })
    )._unsafeUnwrap();

    const artifactId = withArtifact.artifacts[0].id;

    // Different agent approves — should succeed
    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId: createExecutionLeaseId("lease-001"),
        artifactId,
        approvalState: "approved",
        approverAgent: "warp",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    const artifact = output.instance.artifacts.find((a) => a.id === artifactId);
    expect(artifact?.approvalState).toBe("approved");
  });

  it("allows approval when approverAgent is absent (no self-approval check)", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("wf-no-approver");
    await store.instances.create({
      id: instanceId,
      workflowName: "test",
      goal: "test",
      slug: "test",
    });

    const withArtifact = (
      await store.instances.addArtifact(instanceId, {
        name: "plan",
        path: ".weave/plans/test.md",
        producerAgent: "shuttle",
      })
    )._unsafeUnwrap();

    const artifactId = withArtifact.artifacts[0].id;

    // No approverAgent — self-approval check is skipped
    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId: createExecutionLeaseId("lease-001"),
        artifactId,
        approvalState: "approved",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    const artifact = output.instance.artifacts.find((a) => a.id === artifactId);
    expect(artifact?.approvalState).toBe("approved");
  });

  it("allows approval when producerAgent is absent (no self-approval check)", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("wf-no-producer");
    await store.instances.create({
      id: instanceId,
      workflowName: "test",
      goal: "test",
      slug: "test",
    });

    // Artifact without producerAgent
    const withArtifact = (
      await store.instances.addArtifact(instanceId, {
        name: "plan",
        path: ".weave/plans/test.md",
      })
    )._unsafeUnwrap();

    const artifactId = withArtifact.artifacts[0].id;

    // approverAgent is set but producerAgent is absent — no check
    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId: createExecutionLeaseId("lease-001"),
        artifactId,
        approvalState: "approved",
        approverAgent: "shuttle",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  it("approveArtifact can set approvalState to 'rejected'", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("wf-reject");
    await store.instances.create({
      id: instanceId,
      workflowName: "test",
      goal: "test",
      slug: "test",
    });

    const withArtifact = (
      await store.instances.addArtifact(instanceId, {
        name: "plan",
        path: ".weave/plans/test.md",
        producerAgent: "shuttle",
      })
    )._unsafeUnwrap();

    const artifactId = withArtifact.artifacts[0].id;

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId: createExecutionLeaseId("lease-001"),
        artifactId,
        approvalState: "rejected",
        approverAgent: "warp",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    const artifact = output.instance.artifacts.find((a) => a.id === artifactId);
    expect(artifact?.approvalState).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// 3. Approval invalidation — new revision blocks dispatch
// ---------------------------------------------------------------------------

describe("approval invalidation — new revision resets approvalState", () => {
  it("dispatchStep succeeds when normative input artifact is present but never approved (first revision)", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "review-flow",
      WORKFLOW_WITH_NORMATIVE_INPUT,
    );
    const context = makeContext(WORKFLOW_WITH_NORMATIVE_INPUT, "review-flow");

    // Add plan artifact (pending by default, first revision — never approved)
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
    });

    // Dispatch the review step — should succeed (first revision, no prior approval to invalidate)
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "review",
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().stepName).toBe("review");
  });

  it("dispatchStep succeeds when normative input artifact is approved", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "review-flow",
      WORKFLOW_WITH_NORMATIVE_INPUT,
    );
    const context = makeContext(WORKFLOW_WITH_NORMATIVE_INPUT, "review-flow");

    // Add plan artifact and approve it
    const withArtifact = (
      await store.instances.addArtifact(instanceId, {
        name: "plan_path",
        path: ".weave/plans/test.md",
      })
    )._unsafeUnwrap();
    const artifactId = withArtifact.artifacts[0].id;
    await store.instances.updateArtifactApproval(
      instanceId,
      artifactId,
      "approved",
    );

    // Dispatch the review step — should succeed
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "review",
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().stepName).toBe("review");
  });

  it("new revision invalidates prior approval — dispatch is blocked again", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "review-flow",
      WORKFLOW_WITH_NORMATIVE_INPUT,
    );
    const context = makeContext(WORKFLOW_WITH_NORMATIVE_INPUT, "review-flow");

    // Add plan artifact v1 and approve it
    const v1 = (
      await store.instances.addArtifact(instanceId, {
        name: "plan_path",
        path: ".weave/plans/test-v1.md",
      })
    )._unsafeUnwrap();
    const artifactId = v1.artifacts[0].id;
    await store.instances.updateArtifactApproval(
      instanceId,
      artifactId,
      "approved",
    );

    // Add plan artifact v2 — this resets approvalState to "pending"
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test-v2.md",
    });

    // Dispatch the review step — should fail because v2 is pending
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "review",
        context,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("policy_decision");
    expect(error.message).toContain("plan_path");
    // Should mention invalidation
    expect(error.message.toLowerCase()).toContain("invalidat");
  });

  it("dispatch succeeds after re-approving the new revision", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "review-flow",
      WORKFLOW_WITH_NORMATIVE_INPUT,
    );
    const context = makeContext(WORKFLOW_WITH_NORMATIVE_INPUT, "review-flow");

    // Add v1 and approve
    const v1 = (
      await store.instances.addArtifact(instanceId, {
        name: "plan_path",
        path: ".weave/plans/test-v1.md",
      })
    )._unsafeUnwrap();
    await store.instances.updateArtifactApproval(
      instanceId,
      v1.artifacts[0].id,
      "approved",
    );

    // Add v2 (pending)
    const v2 = (
      await store.instances.addArtifact(instanceId, {
        name: "plan_path",
        path: ".weave/plans/test-v2.md",
      })
    )._unsafeUnwrap();

    // Approve v2 (the latest revision)
    const v2Artifact = v2.artifacts.filter((a) => a.name === "plan_path")[1];
    await store.instances.updateArtifactApproval(
      instanceId,
      v2Artifact.id,
      "approved",
    );

    // Dispatch should now succeed
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "review",
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Consumed-revision recording
// ---------------------------------------------------------------------------

describe("consumed-revision recording — dispatchStep records stepAttempts", () => {
  it("dispatchStep records a step attempt with consumed artifact revisions", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "review-flow",
      WORKFLOW_WITH_NORMATIVE_INPUT,
    );
    const context = makeContext(WORKFLOW_WITH_NORMATIVE_INPUT, "review-flow");

    // Add and approve plan artifact
    const withArtifact = (
      await store.instances.addArtifact(instanceId, {
        name: "plan_path",
        path: ".weave/plans/test.md",
      })
    )._unsafeUnwrap();
    const artifactId = withArtifact.artifacts[0].id;
    await store.instances.updateArtifactApproval(
      instanceId,
      artifactId,
      "approved",
    );

    // Dispatch the review step
    const dispatchResult = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "review",
        context,
      },
      store,
    );
    expect(dispatchResult.isOk()).toBe(true);

    // Verify step attempt was recorded
    const instance = (
      await store.instances.getById(instanceId)
    )._unsafeUnwrap();
    expect(instance.stepAttempts).toHaveLength(1);

    const attempt = instance.stepAttempts[0];
    expect(attempt.stepName).toBe("review");
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.dispatchedAt).toBeDefined();
    expect(attempt.consumedArtifacts).toHaveLength(1);

    const consumed = attempt.consumedArtifacts[0];
    expect(consumed.artifactId).toBe(artifactId);
    expect(consumed.name).toBe("plan_path");
    expect(consumed.revision).toBe(1);
  });

  it("dispatchStep records empty consumedArtifacts for steps with no inputs", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "simple-flow",
      WORKFLOW_NO_INPUTS,
    );
    const context = makeContext(WORKFLOW_NO_INPUTS, "simple-flow");

    // Dispatch the work step (no inputs declared)
    const dispatchResult = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "work",
        context,
      },
      store,
    );
    expect(dispatchResult.isOk()).toBe(true);

    const instance = (
      await store.instances.getById(instanceId)
    )._unsafeUnwrap();
    expect(instance.stepAttempts).toHaveLength(1);
    expect(instance.stepAttempts[0].consumedArtifacts).toHaveLength(0);
  });

  it("attempt number increments on each dispatch of the same step", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "review-flow",
      WORKFLOW_WITH_NORMATIVE_INPUT,
    );
    const context = makeContext(WORKFLOW_WITH_NORMATIVE_INPUT, "review-flow");

    // Add and approve plan artifact
    const withArtifact = (
      await store.instances.addArtifact(instanceId, {
        name: "plan_path",
        path: ".weave/plans/test.md",
      })
    )._unsafeUnwrap();
    const artifactId = withArtifact.artifacts[0].id;
    await store.instances.updateArtifactApproval(
      instanceId,
      artifactId,
      "approved",
    );

    // First dispatch
    await dispatchStep(
      { workflowInstanceId: instanceId, leaseId, stepName: "review", context },
      store,
    );

    // Second dispatch (retry)
    await dispatchStep(
      { workflowInstanceId: instanceId, leaseId, stepName: "review", context },
      store,
    );

    const instance = (
      await store.instances.getById(instanceId)
    )._unsafeUnwrap();
    expect(instance.stepAttempts).toHaveLength(2);
    expect(instance.stepAttempts[0].attemptNumber).toBe(1);
    expect(instance.stepAttempts[1].attemptNumber).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Retry reuse — default pinning to prior attempt revisions
// ---------------------------------------------------------------------------

describe("retry reuse — default pinning to prior attempt revisions", () => {
  it("retry reuses consumed revisions from prior attempt by default", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "review-flow",
      WORKFLOW_WITH_NORMATIVE_INPUT,
    );
    const context = makeContext(WORKFLOW_WITH_NORMATIVE_INPUT, "review-flow");

    // Add and approve plan artifact v1
    const v1 = (
      await store.instances.addArtifact(instanceId, {
        name: "plan_path",
        path: ".weave/plans/test-v1.md",
      })
    )._unsafeUnwrap();
    const artifactId = v1.artifacts[0].id;
    await store.instances.updateArtifactApproval(
      instanceId,
      artifactId,
      "approved",
    );

    // First dispatch — records attempt 1 consuming revision 1
    const firstDispatch = await dispatchStep(
      { workflowInstanceId: instanceId, leaseId, stepName: "review", context },
      store,
    );
    expect(firstDispatch.isOk()).toBe(true);

    // Now add plan artifact v2 (pending — would normally block dispatch)
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test-v2.md",
    });

    // Retry dispatch — should reuse v1 revisions from prior attempt (bypass approval check)
    const retryDispatch = await dispatchStep(
      { workflowInstanceId: instanceId, leaseId, stepName: "review", context },
      store,
    );

    // Should succeed because retry pins to prior attempt's consumed revisions
    expect(retryDispatch.isOk()).toBe(true);

    // Verify attempt 2 records the same revision as attempt 1
    const instance = (
      await store.instances.getById(instanceId)
    )._unsafeUnwrap();
    expect(instance.stepAttempts).toHaveLength(2);

    const attempt1 = instance.stepAttempts[0];
    const attempt2 = instance.stepAttempts[1];
    expect(attempt1.consumedArtifacts[0].revision).toBe(1);
    expect(attempt2.consumedArtifacts[0].revision).toBe(1); // pinned to same revision
    expect(attempt2.consumedArtifacts[0].artifactId).toBe(
      attempt1.consumedArtifacts[0].artifactId,
    );
  });

  it("explicit pinnedArtifactRevisions override default retry reuse", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "review-flow",
      WORKFLOW_WITH_NORMATIVE_INPUT,
    );
    const context = makeContext(WORKFLOW_WITH_NORMATIVE_INPUT, "review-flow");

    // Add and approve plan artifact v1
    const v1 = (
      await store.instances.addArtifact(instanceId, {
        name: "plan_path",
        path: ".weave/plans/test-v1.md",
      })
    )._unsafeUnwrap();
    const artifactId = v1.artifacts[0].id;
    await store.instances.updateArtifactApproval(
      instanceId,
      artifactId,
      "approved",
    );

    // First dispatch
    await dispatchStep(
      { workflowInstanceId: instanceId, leaseId, stepName: "review", context },
      store,
    );

    // Add v2 and approve it
    const v2 = (
      await store.instances.addArtifact(instanceId, {
        name: "plan_path",
        path: ".weave/plans/test-v2.md",
      })
    )._unsafeUnwrap();
    const v2Artifact = v2.artifacts.filter((a) => a.name === "plan_path")[1];
    await store.instances.updateArtifactApproval(
      instanceId,
      v2Artifact.id,
      "approved",
    );

    // Explicit pin to v2 — overrides default retry reuse
    const explicitPin: ConsumedArtifactRecord = {
      artifactId: v2Artifact.id,
      name: "plan_path",
      revision: 2,
    };

    const retryDispatch = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "review",
        context,
        pinnedArtifactRevisions: [explicitPin],
      },
      store,
    );

    expect(retryDispatch.isOk()).toBe(true);

    const instance = (
      await store.instances.getById(instanceId)
    )._unsafeUnwrap();
    const attempt2 = instance.stepAttempts[1];
    expect(attempt2.consumedArtifacts[0].revision).toBe(2); // explicitly pinned to v2
  });

  it("first dispatch (no prior attempt) uses current latest revisions", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "review-flow",
      WORKFLOW_WITH_NORMATIVE_INPUT,
    );
    const context = makeContext(WORKFLOW_WITH_NORMATIVE_INPUT, "review-flow");

    // Add and approve plan artifact
    const withArtifact = (
      await store.instances.addArtifact(instanceId, {
        name: "plan_path",
        path: ".weave/plans/test.md",
      })
    )._unsafeUnwrap();
    const artifactId = withArtifact.artifacts[0].id;
    await store.instances.updateArtifactApproval(
      instanceId,
      artifactId,
      "approved",
    );

    // First dispatch — no prior attempt, uses current latest
    const result = await dispatchStep(
      { workflowInstanceId: instanceId, leaseId, stepName: "review", context },
      store,
    );
    expect(result.isOk()).toBe(true);

    const instance = (
      await store.instances.getById(instanceId)
    )._unsafeUnwrap();
    const attempt = instance.stepAttempts[0];
    expect(attempt.consumedArtifacts[0].revision).toBe(1);
    expect(attempt.consumedArtifacts[0].artifactId).toBe(artifactId);
  });
});

// ---------------------------------------------------------------------------
// 6. approveArtifact — metadata sanitization
// ---------------------------------------------------------------------------

describe("approveArtifact — metadata sanitization", () => {
  it("rejects metadata with denied field names", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("wf-meta");
    await store.instances.create({
      id: instanceId,
      workflowName: "test",
      goal: "test",
      slug: "test",
    });
    const withArtifact = (
      await store.instances.addArtifact(instanceId, {
        name: "plan",
        path: ".weave/plans/test.md",
      })
    )._unsafeUnwrap();
    const artifactId = withArtifact.artifacts[0].id;

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId: createExecutionLeaseId("lease-001"),
        artifactId,
        approvalState: "approved",
        metadata: { token: "secret-value" } as Record<string, string>,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// 7. recordStepAttempt — store-level contract
// ---------------------------------------------------------------------------

describe("recordStepAttempt — store-level contract", () => {
  it("records a step attempt with consumed artifacts", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("wf-attempt");
    await store.instances.create({
      id: instanceId,
      workflowName: "test",
      goal: "test",
      slug: "test",
    });

    const consumed: ConsumedArtifactRecord[] = [
      {
        artifactId: createArtifactId("art-001"),
        name: "plan_path",
        revision: 1,
      },
    ];

    const result = await store.instances.recordStepAttempt(
      instanceId,
      "review",
      consumed,
    );
    expect(result.isOk()).toBe(true);

    const instance = result._unsafeUnwrap();
    expect(instance.stepAttempts).toHaveLength(1);
    expect(instance.stepAttempts[0].stepName).toBe("review");
    expect(instance.stepAttempts[0].attemptNumber).toBe(1);
    expect(instance.stepAttempts[0].consumedArtifacts).toHaveLength(1);
    expect(instance.stepAttempts[0].consumedArtifacts[0].name).toBe(
      "plan_path",
    );
    expect(instance.stepAttempts[0].consumedArtifacts[0].revision).toBe(1);
  });

  it("increments attemptNumber for subsequent attempts on the same step", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("wf-multi-attempt");
    await store.instances.create({
      id: instanceId,
      workflowName: "test",
      goal: "test",
      slug: "test",
    });

    await store.instances.recordStepAttempt(instanceId, "review", []);
    await store.instances.recordStepAttempt(instanceId, "review", []);
    const result = await store.instances.recordStepAttempt(
      instanceId,
      "review",
      [],
    );

    const instance = result._unsafeUnwrap();
    expect(instance.stepAttempts).toHaveLength(3);
    expect(instance.stepAttempts[0].attemptNumber).toBe(1);
    expect(instance.stepAttempts[1].attemptNumber).toBe(2);
    expect(instance.stepAttempts[2].attemptNumber).toBe(3);
  });

  it("returns not_found for missing WorkflowInstance", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await store.instances.recordStepAttempt(
      createWorkflowInstanceId("nonexistent"),
      "review",
      [],
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
  });

  it("different steps have independent attempt counters", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("wf-multi-step");
    await store.instances.create({
      id: instanceId,
      workflowName: "test",
      goal: "test",
      slug: "test",
    });

    await store.instances.recordStepAttempt(instanceId, "plan", []);
    await store.instances.recordStepAttempt(instanceId, "plan", []);
    await store.instances.recordStepAttempt(instanceId, "review", []);

    const instance = (
      await store.instances.getById(instanceId)
    )._unsafeUnwrap();
    const planAttempts = instance.stepAttempts.filter(
      (a) => a.stepName === "plan",
    );
    const reviewAttempts = instance.stepAttempts.filter(
      (a) => a.stepName === "review",
    );

    expect(planAttempts[0].attemptNumber).toBe(1);
    expect(planAttempts[1].attemptNumber).toBe(2);
    expect(reviewAttempts[0].attemptNumber).toBe(1);
  });
});
