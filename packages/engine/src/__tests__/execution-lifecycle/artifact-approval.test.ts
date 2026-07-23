/**
 * Tests for terminal-outcomes.ts (approveArtifact) lifecycle module.
 *
 * Verifies:
 * - approveArtifact: lease enforcement, self-approval prohibition, state update
 * - ArtifactApprovalActor shape / gate authorization / revision binding
 */

import { describe, expect, it } from "bun:test";
import {
  approveArtifact,
  createArtifactId,
  createExecutionLeaseId,
  createInMemoryRuntimeStore,
  startExecution,
} from "@weaveio/weave-engine";
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

function userActor() {
  return {
    kind: "user" as const,
    provenance: { command: "/weave:artifact" },
  };
}

function agentActor(
  agentName = "weft",
  gate: "review" | "security" = "review",
) {
  return {
    kind: "agent" as const,
    agentName,
    gate,
  };
}

function makeContext() {
  return {
    workflowName: "review-flow",
    goal: "test goal",
    slug: "test-goal",
    workflows: WORKFLOW_WITH_OUTPUT.workflows ?? {},
  };
}

describe("approveArtifact", () => {
  it("approves an artifact with a user actor and binds revision", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const addResult = await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      producerAgent: "pattern",
    });
    expect(addResult.isOk()).toBe(true);
    if (!addResult.isOk()) return;
    const artifact =
      addResult.value.artifacts[addResult.value.artifacts.length - 1];

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId: artifact.id,
        approvalState: "approved",
        actor: userActor(),
        expectedRevision: artifact.revision,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const updated = result.value.instance.artifacts.find(
      (a) => a.id === artifact.id,
    );
    expect(updated?.approvalState).toBe("approved");
    expect(updated?.approvalActor).toEqual(userActor());
    expect(typeof updated?.approvalDecidedAt).toBe("string");
  });

  it("approves an artifact with an authorized gate agent actor", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const addResult = await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      producerAgent: "pattern",
    });
    expect(addResult.isOk()).toBe(true);
    if (!addResult.isOk()) return;
    const artifact =
      addResult.value.artifacts[addResult.value.artifacts.length - 1];

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId: artifact.id,
        approvalState: "approved",
        actor: agentActor("weft", "review"),
        expectedRevision: artifact.revision,
        context: makeContext(),
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const updated = result.value.instance.artifacts.find(
      (a) => a.id === artifact.id,
    );
    expect(updated?.approvalActor).toEqual(agentActor("weft", "review"));
  });

  it("rejects agent self-approval when actor.agentName === producerAgent", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const addResult = await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      producerAgent: "weft",
    });
    expect(addResult.isOk()).toBe(true);
    if (!addResult.isOk()) return;
    const artifact =
      addResult.value.artifacts[addResult.value.artifacts.length - 1];

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId: artifact.id,
        approvalState: "approved",
        actor: agentActor("weft", "review"),
        expectedRevision: artifact.revision,
        context: makeContext(),
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

  it("rejects unauthorized gate agent (agent does not own the gate step)", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const addResult = await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      producerAgent: "pattern",
    });
    expect(addResult.isOk()).toBe(true);
    if (!addResult.isOk()) return;
    const artifact =
      addResult.value.artifacts[addResult.value.artifacts.length - 1];

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId: artifact.id,
        approvalState: "approved",
        actor: agentActor("warp", "security"),
        expectedRevision: artifact.revision,
        context: makeContext(),
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("unauthorized_actor");
    }
  });

  it("returns validation error when actor is missing", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId: createArtifactId("art-001"),
        approvalState: "approved",
        actor: undefined as never,
        expectedRevision: 1,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("actor");
    }
  });

  it("rejects accessor and extra actor fields without invoking getters", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();
    let getterHits = 0;
    const accessorActor = {
      provenance: { command: "/weave:artifact" },
    } as Record<string, unknown>;
    Object.defineProperty(accessorActor, "kind", {
      enumerable: true,
      get: () => {
        getterHits += 1;
        return "user";
      },
    });

    const accessor = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId: createArtifactId("art-001"),
        approvalState: "approved",
        actor: accessorActor as never,
        expectedRevision: 1,
      },
      store,
    );
    expect(accessor.isErr()).toBe(true);
    expect(getterHits).toBe(0);

    const extra = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId: createArtifactId("art-001"),
        approvalState: "approved",
        actor: {
          kind: "user",
          provenance: { command: "/weave:artifact" },
          injected: true,
        } as never,
        expectedRevision: 1,
      },
      store,
    );
    expect(extra.isErr()).toBe(true);
  });

  it("persists an immutable actor snapshot instead of caller-owned metadata", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();
    const added = await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      producerAgent: "pattern",
    });
    const artifact = added._unsafeUnwrap().artifacts.at(-1);
    if (artifact === undefined) throw new Error("fixture artifact missing");
    const provenance = { command: "/weave:artifact" };
    const actor = { kind: "user" as const, provenance };

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId: artifact.id,
        approvalState: "approved",
        actor,
        expectedRevision: artifact.revision,
      },
      store,
    );
    provenance.command = "mutated";

    const stored = result._unsafeUnwrap().instance.artifacts.at(-1);
    expect(stored?.approvalActor).toEqual(userActor());
    expect(Object.isFrozen(stored?.approvalActor)).toBe(true);
    if (stored?.approvalActor?.kind === "user") {
      expect(Object.isFrozen(stored.approvalActor.provenance)).toBe(true);
    }
  });

  it("returns stale_revision when expectedRevision does not match", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const addResult = await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      producerAgent: "pattern",
    });
    expect(addResult.isOk()).toBe(true);
    if (!addResult.isOk()) return;
    const artifact =
      addResult.value.artifacts[addResult.value.artifacts.length - 1];

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId: artifact.id,
        approvalState: "approved",
        actor: userActor(),
        expectedRevision: artifact.revision + 1,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("stale_revision");
    }
  });

  it("returns validation error when expectedDigest is required but missing", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const addResult = await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      producerAgent: "pattern",
      integrity: {
        algorithm: "sha256",
        digest: "abc123",
      },
    });
    expect(addResult.isOk()).toBe(true);
    if (!addResult.isOk()) return;
    const artifact =
      addResult.value.artifacts[addResult.value.artifacts.length - 1];

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId: artifact.id,
        approvalState: "approved",
        actor: userActor(),
        expectedRevision: artifact.revision,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("expectedDigest");
    }
  });

  it("returns integrity_mismatch when expectedDigest does not match", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const addResult = await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      producerAgent: "pattern",
      integrity: {
        algorithm: "sha256",
        digest: "abc123",
      },
    });
    expect(addResult.isOk()).toBe(true);
    if (!addResult.isOk()) return;
    const artifact =
      addResult.value.artifacts[addResult.value.artifacts.length - 1];

    const result = await approveArtifact(
      {
        workflowInstanceId: instanceId,
        leaseId,
        artifactId: artifact.id,
        approvalState: "approved",
        actor: userActor(),
        expectedRevision: artifact.revision,
        expectedDigest: "different",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("digest_mismatch");
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
        actor: userActor(),
        expectedRevision: 1,
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
        actor: userActor(),
        expectedRevision: 1,
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
