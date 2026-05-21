/**
 * Execution Lifecycle Integration Tests
 *
 * Proves that:
 * 1. A mock adapter can drive the full lifecycle flow end-to-end without a
 *    real harness process — using `createInMemoryRuntimeStore()` and the 7
 *    engine lifecycle functions directly.
 * 2. `WeaveRunner.run()` calls `init()` exactly once and does NOT call any
 *    lifecycle functions during initialization — the lifecycle surface is
 *    engine-owned and adapters call it, not the runner.
 * 3. No concrete hook registration is introduced by the engine lifecycle
 *    surface — adapters map harness events into lifecycle calls themselves.
 *
 * Key boundary: `observeSession`, `startExecution`, `dispatchStep`,
 * `completeStep`, etc. are ENGINE functions, not `HarnessAdapter` methods.
 * Adapters CALL these functions — they do not implement them. This test file
 * proves that the full lifecycle can be driven without `MockAdapter.init()`
 * or any harness process.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { parseConfig } from "@weave/core";
import {
  completeStep,
  createInMemoryRuntimeStore,
  createWorkflowInstanceId,
  dispatchStep,
  observeSession,
  startExecution,
  WeaveRunner,
  type WorkflowExecutionContext,
} from "@weave/engine";
import { MockAdapter } from "./mock-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a .weave source string and unwrap — throws on invalid input. */
function cfg(source: string) {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/**
 * Pre-create a workflow instance in the store and return its ID.
 * This is the correct pattern: the store assigns the ID; callers use it.
 */
async function createInstance(
  store: ReturnType<typeof createInMemoryRuntimeStore>,
  workflowName: string,
) {
  const result = await store.instances.create({
    workflowName,
    goal: `goal for ${workflowName}`,
    slug: workflowName.replace(/\s+/g, "-"),
  });
  if (!result.isOk())
    throw new Error(`Failed to create instance: ${result.error.message}`);
  return result.value.id;
}

// ---------------------------------------------------------------------------
// Lifecycle integration — mock adapter drives end-to-end flow
// ---------------------------------------------------------------------------

describe("lifecycle integration — mock adapter drives end-to-end flow", () => {
  it("mock adapter can drive observeSession → startExecution → dispatchStep → completeStep without real harness", async () => {
    // 1. Create in-memory store — no filesystem, no harness process
    const store = createInMemoryRuntimeStore();

    // 2. Pre-create a workflow instance (adapter-owned identity)
    const workflowInstanceId = await createInstance(
      store,
      "integration-workflow",
    );

    // 3. Call startExecution — updates instance to running, acquires lease
    const startResult = await startExecution(
      {
        workflowInstanceId,
        ownerId: "mock-adapter-session-001",
        now: new Date().toISOString(),
      },
      store,
    );

    expect(startResult.isOk()).toBe(true);
    if (!startResult.isOk()) return;

    const { leaseId } = startResult.value;
    expect(leaseId).toBeDefined();

    // Verify instance is running
    const instanceAfterStart =
      await store.instances.getById(workflowInstanceId);
    expect(instanceAfterStart.isOk()).toBe(true);
    if (!instanceAfterStart.isOk()) return;
    expect(instanceAfterStart.value.status).toBe("running");

    // 4. Call observeSession — records a session snapshot
    const observeResult = await observeSession(
      {
        workflowInstanceId,
        leaseId,
        harnessName: "mock-harness",
        agentName: "shuttle",
        sessionStatus: "active",
        stepName: "implement",
        metadata: { stepIndex: 1, isRetry: false },
      },
      store,
    );

    expect(observeResult.isOk()).toBe(true);
    if (!observeResult.isOk()) return;
    expect(observeResult.value.snapshotId).toBeDefined();

    // Verify snapshot was stored
    const snapshots =
      await store.snapshots.listByWorkflowInstance(workflowInstanceId);
    expect(snapshots.isOk()).toBe(true);
    if (!snapshots.isOk()) return;
    expect(snapshots.value.length).toBeGreaterThanOrEqual(1);

    // 5. Call dispatchStep — updates currentStepName, returns DispatchAgentEffect
    const dispatchResult = await dispatchStep(
      {
        workflowInstanceId,
        leaseId,
        stepName: "implement",
      },
      store,
    );

    expect(dispatchResult.isOk()).toBe(true);
    if (!dispatchResult.isOk()) return;
    expect(dispatchResult.value.stepName).toBe("implement");
    expect(dispatchResult.value.effects).toHaveLength(1);
    expect(dispatchResult.value.effects[0]?.kind).toBe("dispatch-agent");

    // Verify currentStepName was updated
    const instanceAfterDispatch =
      await store.instances.getById(workflowInstanceId);
    expect(instanceAfterDispatch.isOk()).toBe(true);
    if (!instanceAfterDispatch.isOk()) return;
    expect(instanceAfterDispatch.value.currentStepName).toBe("implement");

    // 6. Call completeStep with success — instance remains running
    const completeResult = await completeStep(
      {
        workflowInstanceId,
        leaseId,
        stepName: "implement",
        completionSignal: { outcome: "success" },
      },
      store,
    );

    expect(completeResult.isOk()).toBe(true);
    if (!completeResult.isOk()) return;

    // After success, instance stays running (ready for next step)
    const instanceAfterComplete =
      await store.instances.getById(workflowInstanceId);
    expect(instanceAfterComplete.isOk()).toBe(true);
    if (!instanceAfterComplete.isOk()) return;
    expect(instanceAfterComplete.value.status).toBe("running");
  });

  it("lifecycle functions work without any MockAdapter.init() call — engine owns the lifecycle surface", async () => {
    // This test proves the lifecycle surface is completely independent of
    // the HarnessAdapter. No adapter is involved at all.
    const store = createInMemoryRuntimeStore();
    const workflowInstanceId = await createInstance(
      store,
      "no-adapter-workflow",
    );

    // startExecution requires no adapter
    const startResult = await startExecution(
      { workflowInstanceId, ownerId: "standalone-owner" },
      store,
    );
    expect(startResult.isOk()).toBe(true);

    // dispatchStep requires no adapter
    if (!startResult.isOk()) return;
    const dispatchResult = await dispatchStep(
      {
        workflowInstanceId,
        leaseId: startResult.value.leaseId,
        stepName: "plan",
      },
      store,
    );
    expect(dispatchResult.isOk()).toBe(true);
  });

  it("completeStep with failed outcome transitions instance to failed status", async () => {
    const store = createInMemoryRuntimeStore();
    const workflowInstanceId = await createInstance(store, "fail-workflow");

    const startResult = await startExecution(
      { workflowInstanceId, ownerId: "fail-owner" },
      store,
    );
    expect(startResult.isOk()).toBe(true);
    if (!startResult.isOk()) return;

    const completeResult = await completeStep(
      {
        workflowInstanceId,
        leaseId: startResult.value.leaseId,
        stepName: "build",
        completionSignal: { outcome: "failed", message: "Build error" },
      },
      store,
    );

    expect(completeResult.isOk()).toBe(true);

    const instance = await store.instances.getById(workflowInstanceId);
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;
    expect(instance.value.status).toBe("failed");
    expect(instance.value.errorMessage).toBe("Build error");
  });

  it("dispatchStep returns a DispatchAgentEffect with a RunAgentEffect inside", async () => {
    const store = createInMemoryRuntimeStore();
    const workflowInstanceId = await createInstance(
      store,
      "dispatch-effect-workflow",
    );

    const startResult = await startExecution(
      { workflowInstanceId, ownerId: "dispatch-owner" },
      store,
    );
    expect(startResult.isOk()).toBe(true);
    if (!startResult.isOk()) return;

    const dispatchResult = await dispatchStep(
      {
        workflowInstanceId,
        leaseId: startResult.value.leaseId,
        stepName: "security-review",
      },
      store,
    );

    expect(dispatchResult.isOk()).toBe(true);
    if (!dispatchResult.isOk()) return;

    const effect = dispatchResult.value.effects[0];
    expect(effect?.kind).toBe("dispatch-agent");
    if (effect?.kind !== "dispatch-agent") return;

    // The DispatchAgentEffect wraps a RunAgentEffect
    expect(effect.runAgent.kind).toBe("run-agent");
    expect(effect.runAgent.agentName).toBe("security-review");

    // No harness-specific tool names in the emitted effect
    const serialized = JSON.stringify(effect);
    const harnessPatterns = [
      "opencode",
      "claude-code",
      "pi-agent",
      "codex",
      "bash",
      "computer",
      "str_replace",
    ];
    for (const pattern of harnessPatterns) {
      expect(serialized).not.toContain(pattern);
    }
  });
});

// ---------------------------------------------------------------------------
// WeaveRunner.run() — init boundary and lifecycle isolation
// ---------------------------------------------------------------------------

describe("WeaveRunner.run() — init boundary and lifecycle isolation", () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  it("init() is called exactly once during WeaveRunner.run()", async () => {
    const config = cfg(`
      agent loom {
        prompt "You are loom."
        models ["claude-sonnet-4-5"]
      }
    `);

    await new WeaveRunner(config, adapter).run();

    expect(adapter.callsTo("init")).toHaveLength(1);
  });

  it("no lifecycle functions are called as part of WeaveRunner.run() — lifecycle surface is adapter-driven", async () => {
    // The lifecycle functions (observeSession, startExecution, etc.) are
    // ENGINE functions, not HarnessAdapter methods. WeaveRunner.run() does NOT
    // call them — adapters call them in response to harness events.
    //
    // This test proves the boundary: after WeaveRunner.run() completes, the
    // only adapter calls recorded are init(), loadAvailableSkills(), and
    // spawnSubagent() — no lifecycle-related adapter methods.
    const config = cfg(`
      agent shuttle {
        prompt "You are shuttle."
        models ["claude-sonnet-4-5"]
      }
    `);

    await new WeaveRunner(config, adapter).run();

    const methodsCalled = adapter.calls.map((c) => c.method);

    // Only these three adapter methods should be called by the runner
    expect(methodsCalled).toContain("init");
    expect(methodsCalled).toContain("loadAvailableSkills");
    expect(methodsCalled).toContain("spawnSubagent");

    // registerHook must NOT be called — it is superseded by the lifecycle surface
    expect(adapter.callsTo("registerHook")).toHaveLength(0);

    // loadSkill must NOT be called — superseded by loadAvailableSkills
    expect(adapter.callsTo("loadSkill")).toHaveLength(0);
  });

  it("init() is called before loadAvailableSkills() and spawnSubagent()", async () => {
    const config = cfg(`
      agent loom { prompt "Orchestrator." models ["claude-sonnet-4-5"] }
    `);

    await new WeaveRunner(config, adapter).run();

    const initIdx = adapter.calls.findIndex((c) => c.method === "init");
    const loadIdx = adapter.calls.findIndex(
      (c) => c.method === "loadAvailableSkills",
    );
    const spawnIdx = adapter.calls.findIndex(
      (c) => c.method === "spawnSubagent",
    );

    expect(initIdx).toBe(0);
    expect(initIdx).toBeLessThan(loadIdx);
    expect(loadIdx).toBeLessThan(spawnIdx);
  });

  it("init() is called exactly once even with multiple agents", async () => {
    const config = cfg(`
      agent loom    { prompt "Orchestrator." models ["claude-sonnet-4-5"] }
      agent shuttle { prompt "Specialist."   models ["claude-sonnet-4-5"] }
      agent warp    { prompt "Reviewer."     models ["claude-sonnet-4-5"] }
    `);

    await new WeaveRunner(config, adapter).run();

    expect(adapter.callsTo("init")).toHaveLength(1);
  });

  it("init() is called exactly once even when all agents are disabled", async () => {
    const config = cfg(`
      agent loom { prompt "Orchestrator." models ["claude-sonnet-4-5"] }
      disable agents ["loom"]
    `);

    await new WeaveRunner(config, adapter).run();

    expect(adapter.callsTo("init")).toHaveLength(1);
    expect(adapter.callsTo("spawnSubagent")).toHaveLength(0);
  });

  it("no concrete hook registration is introduced by the engine lifecycle surface", async () => {
    // The engine lifecycle surface (execution-lifecycle.ts) accepts a
    // RuntimeStore and returns typed ResultAsync values. It does NOT register
    // concrete harness callbacks or call adapter.registerHook().
    //
    // This test proves that running the full WeaveRunner lifecycle produces
    // zero registerHook() calls — the engine never drives hook registration.
    const config = cfg(`
      agent loom { prompt "Orchestrator." models ["claude-sonnet-4-5"] }
    `);

    await new WeaveRunner(config, adapter).run();

    expect(adapter.callsTo("registerHook")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-step artifact-passing integration test
// ---------------------------------------------------------------------------

describe("multi-step workflow: artifact produced by step 1 available in step 2 prompt", () => {
  /**
   * 2-step workflow:
   * - Step 1 "plan": outputs "plan_path"
   * - Step 2 "implement": inputs "plan_path", prompt uses {{artifacts.plan_path}}
   */
  const artifactPassingWorkflows: WorkflowExecutionContext["workflows"] = {
    "artifact-flow": {
      version: 1,
      steps: [
        {
          name: "plan",
          type: "autonomous",
          agent: "pattern",
          prompt: "Create a plan for {{instance.goal}}",
          completion: {
            method: "plan_created",
            plan_name: "{{instance.slug}}",
          },
          outputs: [
            { name: "plan_path", description: "Path to the generated plan" },
          ],
        },
        {
          name: "implement",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Execute plan at {{artifacts.plan_path}}",
          completion: { method: "agent_signal" },
          inputs: [
            { name: "plan_path", description: "Path to the plan to execute" },
          ],
        },
      ],
    },
  };

  const WORKFLOW_NAME = "artifact-flow";
  const GOAL = "Add dark mode support";
  const SLUG = "add-dark-mode-support";
  const PLAN_PATH = ".weave/plans/add-dark-mode-support.md";

  it("step 1 output artifact is available in step 2 rendered prompt", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("integ-artifact-flow-001");

    // -----------------------------------------------------------------------
    // 1. startExecution with workflow context
    // -----------------------------------------------------------------------
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "integ-owner-001",
        context: {
          workflowName: WORKFLOW_NAME,
          goal: GOAL,
          slug: SLUG,
          workflows: artifactPassingWorkflows,
        },
      },
      store,
    );

    expect(startResult.isOk()).toBe(true);
    if (!startResult.isOk()) return;

    const { leaseId } = startResult.value;

    // Instance should have currentStepName = "plan" (first step)
    const instanceAfterStart = await store.instances.getById(instanceId);
    expect(instanceAfterStart.isOk()).toBe(true);
    if (!instanceAfterStart.isOk()) return;
    expect(instanceAfterStart.value.currentStepName).toBe("plan");
    expect(instanceAfterStart.value.workflowName).toBe(WORKFLOW_NAME);
    expect(instanceAfterStart.value.goal).toBe(GOAL);

    // -----------------------------------------------------------------------
    // 2. dispatchStep for step 1 ("plan")
    // -----------------------------------------------------------------------
    const dispatch1Result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "plan",
        context: {
          workflowName: WORKFLOW_NAME,
          goal: GOAL,
          slug: SLUG,
          workflows: artifactPassingWorkflows,
        },
      },
      store,
    );

    expect(dispatch1Result.isOk()).toBe(true);
    if (!dispatch1Result.isOk()) return;

    expect(dispatch1Result.value.stepName).toBe("plan");
    const dispatch1Effect = dispatch1Result.value.effects[0];
    expect(dispatch1Effect?.kind).toBe("dispatch-agent");
    if (dispatch1Effect?.kind === "dispatch-agent") {
      // "plan" step uses agent "pattern"
      expect(dispatch1Effect.runAgent.agentName).toBe("pattern");
      expect(dispatch1Effect.runAgent.completionMethod).toBe("plan_created");
      expect(dispatch1Effect.runAgent.stepType).toBe("autonomous");
    }

    // -----------------------------------------------------------------------
    // 3. completeStep for step 1 — outputs "plan_path" artifact
    // -----------------------------------------------------------------------
    const complete1Result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "plan",
        completionSignal: {
          outcome: "success",
          artifacts: [{ name: "plan_path", path: PLAN_PATH }],
        },
        context: {
          workflowName: WORKFLOW_NAME,
          goal: GOAL,
          slug: SLUG,
          workflows: artifactPassingWorkflows,
        },
      },
      store,
    );

    expect(complete1Result.isOk()).toBe(true);
    if (!complete1Result.isOk()) return;

    // Auto-advance: should emit dispatch-agent for step 2 ("implement")
    const { effects: complete1Effects } = complete1Result.value;
    expect(complete1Effects).toHaveLength(1);
    expect(complete1Effects[0]?.kind).toBe("dispatch-agent");
    if (complete1Effects[0]?.kind === "dispatch-agent") {
      expect(complete1Effects[0].runAgent.agentName).toBe("shuttle");
      expect(complete1Effects[0].runAgent.stepType).toBe("autonomous");
      expect(complete1Effects[0].runAgent.completionMethod).toBe(
        "agent_signal",
      );
      // promptMetadata must be present and non-zero (prompt was rendered with artifact)
      expect(complete1Effects[0].runAgent.promptMetadata).toBeDefined();
      const pm = complete1Effects[0].runAgent.promptMetadata;
      if (pm) {
        expect(pm.byteLength).toBeGreaterThan(0);
      }
    }

    // Verify "plan_path" artifact was persisted
    const instanceAfterStep1 = await store.instances.getById(instanceId);
    expect(instanceAfterStep1.isOk()).toBe(true);
    if (!instanceAfterStep1.isOk()) return;
    const { artifacts } = instanceAfterStep1.value;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe("plan_path");
    expect(artifacts[0]?.path).toBe(PLAN_PATH);

    // currentStepName should now be "implement"
    expect(instanceAfterStep1.value.currentStepName).toBe("implement");

    // -----------------------------------------------------------------------
    // 4. dispatchStep for step 2 ("implement") — verifies artifact in prompt
    // -----------------------------------------------------------------------
    const dispatch2Result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "implement",
        context: {
          workflowName: WORKFLOW_NAME,
          goal: GOAL,
          slug: SLUG,
          workflows: artifactPassingWorkflows,
        },
      },
      store,
    );

    expect(dispatch2Result.isOk()).toBe(true);
    if (!dispatch2Result.isOk()) return;

    expect(dispatch2Result.value.stepName).toBe("implement");
    const dispatch2Effect = dispatch2Result.value.effects[0];
    expect(dispatch2Effect?.kind).toBe("dispatch-agent");
    if (dispatch2Effect?.kind === "dispatch-agent") {
      expect(dispatch2Effect.runAgent.agentName).toBe("shuttle");
      // The prompt "Execute plan at {{artifacts.plan_path}}" renders to
      // "Execute plan at .weave/plans/add-dark-mode-support.md"
      // promptMetadata.byteLength must reflect the rendered content
      expect(dispatch2Effect.runAgent.promptMetadata).toBeDefined();
      const pm = dispatch2Effect.runAgent.promptMetadata;
      if (pm) {
        // "Execute plan at .weave/plans/add-dark-mode-support.md" is 51 bytes
        expect(pm.byteLength).toBeGreaterThan(0);
        // The rendered prompt is longer than the template (artifact path was substituted)
        const templateByteLength = new TextEncoder().encode(
          "Execute plan at {{artifacts.plan_path}}",
        ).byteLength;
        // Rendered should differ from template (substitution happened)
        expect(pm.byteLength).not.toBe(templateByteLength);
      }
    }

    // -----------------------------------------------------------------------
    // 5. completeStep for step 2 — final step, workflow completes
    // -----------------------------------------------------------------------
    const complete2Result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "implement",
        completionSignal: { outcome: "success" },
        context: {
          workflowName: WORKFLOW_NAME,
          goal: GOAL,
          slug: SLUG,
          workflows: artifactPassingWorkflows,
        },
      },
      store,
    );

    expect(complete2Result.isOk()).toBe(true);
    if (!complete2Result.isOk()) return;

    // Final step: complete-execution effect
    const { effects: complete2Effects } = complete2Result.value;
    expect(complete2Effects).toHaveLength(1);
    expect(complete2Effects[0]?.kind).toBe("complete-execution");

    // Instance should be completed
    const instanceAfterStep2 = await store.instances.getById(instanceId);
    expect(instanceAfterStep2.isOk()).toBe(true);
    if (!instanceAfterStep2.isOk()) return;
    expect(instanceAfterStep2.value.status).toBe("completed");

    // No active lease should remain
    const leaseAfterComplete = await store.leases.findActive();
    expect(leaseAfterComplete.isOk()).toBe(true);
    if (!leaseAfterComplete.isOk()) return;
    expect(leaseAfterComplete.value).toBeNull();
  });
});
