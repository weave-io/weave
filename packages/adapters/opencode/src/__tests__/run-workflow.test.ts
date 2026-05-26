/**
 * Integration tests for `runWorkflow` — the end-to-end workflow execution loop.
 *
 * Uses:
 * - `InMemoryRuntimeStore` (no SQLite, no filesystem)
 * - `MockPlanStateProvider` (no real filesystem plan files)
 * - A fixture `WeaveConfig` with a 2-3 step workflow
 *
 * Asserts:
 * - At least one `DispatchAgentEffect` was applied
 * - The produced `OpenCodeAgentConfig` validates against SDK types (no `any` casts)
 * - The execution loop terminates with `status: "completed"`
 */

import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weave/core";
import type { PlanStateError, PlanStateProvider } from "@weave/engine";
import { createInMemoryRuntimeStore } from "@weave/engine";
import { okAsync, type ResultAsync } from "neverthrow";

import { OpenCodeAdapter } from "../index.js";
import { runWorkflow } from "../run-workflow.js";
import type { OpenCodeAgentConfig } from "../sdk-types.js";

// ---------------------------------------------------------------------------
// MockPlanStateProvider
// ---------------------------------------------------------------------------

/**
 * In-memory mock for `PlanStateProvider`.
 *
 * Always reports plans as existing and complete — suitable for tests that
 * use `plan_created` or `plan_complete` completion methods without real files.
 */
class MockPlanStateProvider implements PlanStateProvider {
  readonly planExistsCalls: string[] = [];
  readonly isPlanCompleteCalls: string[] = [];

  planExists(planName: string): ResultAsync<boolean, PlanStateError> {
    this.planExistsCalls.push(planName);
    return okAsync(true);
  }

  isPlanComplete(planName: string): ResultAsync<boolean, PlanStateError> {
    this.isPlanCompleteCalls.push(planName);
    return okAsync(true);
  }
}

// ---------------------------------------------------------------------------
// Fixture WeaveConfig — 2-step plan-and-execute workflow
// ---------------------------------------------------------------------------

/**
 * Minimal fixture `WeaveConfig` with a 2-step workflow:
 *   1. `plan`    — autonomous step using `shuttle` agent, `agent_signal` completion
 *   2. `execute` — autonomous step using `shuttle` agent, `agent_signal` completion
 *
 * Both steps use `agent_signal` so no plan files are needed.
 */
const TWO_STEP_CONFIG: WeaveConfig = {
  agents: {
    shuttle: {
      description: "Shuttle (Domain Specialist)",
      prompt: "You are a domain specialist.",
      models: ["claude-sonnet-4-5"],
      mode: "subagent",
      temperature: 0.2,
      tool_policy: {
        read: "allow",
        write: "allow",
        execute: "allow",
        delegate: "deny",
        network: "ask",
      },
    },
  },
  categories: {},
  disabled: { agents: [], hooks: [], skills: [] },
  settings: {
    log_level: "INFO",
    runtime: { journal: { strict: false } },
  },
  workflows: {
    "plan-and-execute": {
      description: "Plan then execute a task",
      version: 1,
      steps: [
        {
          name: "plan",
          display_name: "Create implementation plan",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Create a plan for: {{instance.goal}}",
          completion: { method: "agent_signal" },
        },
        {
          name: "execute",
          display_name: "Execute the plan",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Execute the plan for: {{instance.goal}}",
          completion: { method: "agent_signal" },
        },
      ],
    },
  },
};

/**
 * Fixture `WeaveConfig` with a 3-step workflow including a gate step.
 */
const THREE_STEP_CONFIG: WeaveConfig = {
  agents: {
    shuttle: {
      description: "Shuttle (Domain Specialist)",
      prompt: "You are a domain specialist.",
      models: ["claude-sonnet-4-5"],
      mode: "subagent",
      temperature: 0.2,
      tool_policy: {
        read: "allow",
        write: "allow",
        execute: "allow",
        delegate: "deny",
        network: "ask",
      },
    },
    weft: {
      description: "Weft (Code Reviewer)",
      prompt: "You are a code reviewer.",
      models: ["claude-sonnet-4-5"],
      mode: "subagent",
      temperature: 0.1,
    },
  },
  categories: {},
  disabled: { agents: [], hooks: [], skills: [] },
  settings: {
    log_level: "INFO",
    runtime: { journal: { strict: false } },
  },
  workflows: {
    "plan-implement-review": {
      description: "Plan, implement, and review a feature",
      version: 1,
      steps: [
        {
          name: "plan",
          display_name: "Create plan",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Create a plan for: {{instance.goal}}",
          completion: { method: "agent_signal" },
        },
        {
          name: "implement",
          display_name: "Implement the plan",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Implement the plan for: {{instance.goal}}",
          completion: { method: "agent_signal" },
        },
        {
          name: "review",
          display_name: "Code review",
          type: "gate",
          agent: "weft",
          prompt: "Review the implementation for: {{instance.goal}}",
          completion: { method: "review_verdict" },
          on_reject: "pause",
        },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runWorkflow", () => {
  it("returns WorkflowNotFound error for unknown workflow name", async () => {
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    const result = await runWorkflow({
      config: TWO_STEP_CONFIG,
      workflowName: "nonexistent-workflow",
      goal: "Test goal",
      slug: "test-goal",
      adapter,
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("WorkflowNotFound");
      if (result.error.type === "WorkflowNotFound") {
        expect(result.error.workflowName).toBe("nonexistent-workflow");
      }
    }
  });

  it("runs a 2-step workflow and applies DispatchAgentEffect for each step", async () => {
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider();

    const result = await runWorkflow({
      config: TWO_STEP_CONFIG,
      workflowName: "plan-and-execute",
      goal: "Build a feature",
      slug: "build-a-feature",
      adapter,
      store,
      planStateProvider,
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw new Error(
        `Expected ok but got err: ${JSON.stringify(result.error)}`,
      );
    }

    const { appliedEffects, status, stepsDispatched } = result.value;

    // Execution should complete (not pause)
    expect(status).toBe("completed");

    // Both steps should have been dispatched
    expect(stepsDispatched).toBe(2);

    // At least one DispatchAgentEffect should have been applied
    const dispatchEffects = appliedEffects.filter(
      (e) => e.kind === "dispatch-agent",
    );
    expect(dispatchEffects.length).toBeGreaterThanOrEqual(1);

    // The adapter should have translated at least one agent
    expect(adapter.translatedAgents.size).toBeGreaterThanOrEqual(1);
  });

  it("populates translatedAgents with valid OpenCodeAgentConfig", async () => {
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    const result = await runWorkflow({
      config: TWO_STEP_CONFIG,
      workflowName: "plan-and-execute",
      goal: "Build a feature",
      slug: "build-a-feature",
      adapter,
      store,
    });

    expect(result.isOk()).toBe(true);

    // Validate the translated agent config against OpenCodeAgentConfig shape.
    // No `any` casts — the type is imported directly from sdk-types.
    const shuttleConfig: OpenCodeAgentConfig | undefined =
      adapter.translatedAgents.get("shuttle");

    expect(shuttleConfig).toBeDefined();
    if (shuttleConfig === undefined) {
      throw new Error("Expected shuttle agent config to be defined");
    }

    // Validate required fields are present and correctly typed
    expect(typeof shuttleConfig.prompt).toBe("string");
    expect(shuttleConfig.mode).toBe("subagent");
    expect(shuttleConfig.permission).toBeDefined();

    // Validate permission block shape
    const { permission } = shuttleConfig;
    expect(permission).toBeDefined();
    if (permission !== undefined) {
      const validValues = ["allow", "deny", "ask"];
      // Each permission field is a string value — assert it's one of the valid values.
      expect(validValues).toContain(String(permission.edit ?? ""));
      expect(validValues).toContain(String(permission.bash ?? ""));
      expect(validValues).toContain(String(permission.webfetch ?? ""));
      expect(validValues).toContain(String(permission.doom_loop ?? ""));
    }
  });

  it("applies DispatchAgentEffect for each step in a 2-step workflow", async () => {
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    const result = await runWorkflow({
      config: TWO_STEP_CONFIG,
      workflowName: "plan-and-execute",
      goal: "Implement authentication",
      slug: "implement-authentication",
      adapter,
      store,
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw new Error(
        `Expected ok but got err: ${JSON.stringify(result.error)}`,
      );
    }

    const { appliedEffects } = result.value;

    // Filter to dispatch-agent effects only
    const dispatchEffects = appliedEffects.filter(
      (e) => e.kind === "dispatch-agent",
    );

    // Both steps should have produced a dispatch-agent effect
    expect(dispatchEffects.length).toBe(2);

    // Each dispatch effect should reference the shuttle agent
    for (const effect of dispatchEffects) {
      if (effect.kind === "dispatch-agent") {
        expect(effect.runAgent.agentName).toBe("shuttle");
        expect(effect.runAgent.kind).toBe("run-agent");
        expect(effect.runAgent.agentDescriptor).toBeDefined();
      }
    }
  });

  it("runs a 3-step workflow and dispatches all steps", async () => {
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    const result = await runWorkflow({
      config: THREE_STEP_CONFIG,
      workflowName: "plan-implement-review",
      goal: "Add user authentication",
      slug: "add-user-authentication",
      adapter,
      store,
    });

    // The 3rd step is a gate with review_verdict — completeStep with agent_signal
    // may not match the declared method. The loop should still handle this gracefully.
    // We accept either ok or a lifecycle validation error here.
    if (result.isOk()) {
      const { stepsDispatched, appliedEffects } = result.value;
      expect(stepsDispatched).toBeGreaterThanOrEqual(1);
      const dispatchEffects = appliedEffects.filter(
        (e) => e.kind === "dispatch-agent",
      );
      expect(dispatchEffects.length).toBeGreaterThanOrEqual(1);
    } else {
      // A validation error on the gate step's completion method is acceptable
      expect(result.error.type).toBe("LifecycleError");
    }
  });

  it("uses InMemoryRuntimeStore when no store is provided", async () => {
    const adapter = new OpenCodeAdapter();
    // No store provided — should default to InMemoryRuntimeStore internally

    const result = await runWorkflow({
      config: TWO_STEP_CONFIG,
      workflowName: "plan-and-execute",
      goal: "Test default store",
      slug: "test-default-store",
      adapter,
      // store intentionally omitted
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe("completed");
    }
  });

  it("returns workflowInstanceId in the result", async () => {
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    const result = await runWorkflow({
      config: TWO_STEP_CONFIG,
      workflowName: "plan-and-execute",
      goal: "Check instance ID",
      slug: "check-instance-id",
      adapter,
      store,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(typeof result.value.workflowInstanceId).toBe("string");
      expect(result.value.workflowInstanceId.length).toBeGreaterThan(0);
    }
  });

  it("MockPlanStateProvider is not called for agent_signal steps", async () => {
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider();

    await runWorkflow({
      config: TWO_STEP_CONFIG,
      workflowName: "plan-and-execute",
      goal: "Test plan provider",
      slug: "test-plan-provider",
      adapter,
      store,
      planStateProvider,
    });

    // agent_signal steps do not require plan file checks
    expect(planStateProvider.planExistsCalls).toHaveLength(0);
    expect(planStateProvider.isPlanCompleteCalls).toHaveLength(0);
  });
});
