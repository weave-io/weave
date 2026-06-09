import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weave/core";
import type {
  AgentDescriptor,
  ExecutionStartedData,
  PlanStateProvider,
} from "@weave/engine";
import { createInMemoryRuntimeStore } from "@weave/engine";
import { okAsync, type ResultAsync } from "neverthrow";

import {
  OpenCodeAdapter,
  type OpenCodeAdapterError,
} from "../adapter.js";
import { buildStartPlanToolHandler } from "../command-tools.js";
import {
  RuntimeCommandProjection,
  type ProjectionResult,
} from "../runtime-command-projection.js";
import { DEFAULT_EXECUTION_WORKFLOW } from "../start-plan-execution.js";

class TestOpenCodeAdapter extends OpenCodeAdapter {
  override spawnSubagent(
    _descriptor: AgentDescriptor,
  ): ResultAsync<void, OpenCodeAdapterError> {
    return okAsync(undefined);
  }
}

const TEST_CONFIG: WeaveConfig = {
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
  extend_before_plan: { steps: [] },
  workflows: {
    [DEFAULT_EXECUTION_WORKFLOW]: {
      description: "Execute an existing named plan",
      version: 1,
      steps: [
        {
          name: "execute",
          display_name: "Execute",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Execute plan: {{instance.goal}}",
          completion: { method: "agent_signal" },
        },
      ],
    },
  },
};

function makePlanStateProvider(): PlanStateProvider {
  return {
    planExists: (_planName) => okAsync(true),
    isPlanComplete: (_planName) => okAsync(true),
  };
}

function makeExecutionStartedData(planName: string): ExecutionStartedData {
  return {
    kind: "execution-started",
    workflowInstanceId:
      "workflow-instance-1" as ExecutionStartedData["workflowInstanceId"],
    leaseId: "lease-1" as ExecutionStartedData["leaseId"],
    workflowName: DEFAULT_EXECUTION_WORKFLOW,
    goal: `Execute plan: ${planName}`,
    slug: planName,
    effects: [],
  };
}

function createDependencies(adapter: OpenCodeAdapter) {
  return {
    config: TEST_CONFIG,
    adapter,
    store: createInMemoryRuntimeStore(),
  };
}

async function withPatchedHandleStartPlan(
  implementation: RuntimeCommandProjection["handleStartPlan"],
  callback: () => Promise<void>,
): Promise<void> {
  const original = RuntimeCommandProjection.prototype.handleStartPlan;
  RuntimeCommandProjection.prototype.handleStartPlan = implementation;

  try {
    await callback();
  } finally {
    RuntimeCommandProjection.prototype.handleStartPlan = original;
  }
}

describe("buildStartPlanToolHandler", () => {
  it("Should_return_success_message_when_plan_exists", async () => {
    const adapter = new TestOpenCodeAdapter({ projectRoot: "C:/test-project" });
    await adapter.init();
    adapter.planStateProvider = makePlanStateProvider();

    await withPatchedHandleStartPlan(async (input) => ({
      outcome: "success",
      command: "/weave:start",
      data: makeExecutionStartedData(input.planName),
      message: "Plan started",
    }), async () => {
      const handler = buildStartPlanToolHandler(createDependencies(adapter));

      const result = await handler({ planName: "feature-auth" });

      expect(result).toBe("Plan started");
    });
  });

  it("Should_return_failure_message_when_plan_not_found", async () => {
    const adapter = new TestOpenCodeAdapter({ projectRoot: "C:/test-project" });
    await adapter.init();
    adapter.planStateProvider = makePlanStateProvider();

    await withPatchedHandleStartPlan(async () => ({
      outcome: "failure",
      command: "/weave:start",
      error: {
        type: "command_not_found",
        entity: "plan",
        name: "missing-plan",
        message: "Plan was not found",
      },
      message: "Plan was not found",
    }), async () => {
      const handler = buildStartPlanToolHandler(createDependencies(adapter));

      const result = await handler({ planName: "missing-plan" });

      expect(result).toBe("Plan was not found");
    });
  });

  it("Should_return_message_and_hint_when_outcome_is_degraded", async () => {
    const adapter = new TestOpenCodeAdapter({ projectRoot: "C:/test-project" });
    await adapter.init();
    adapter.planStateProvider = makePlanStateProvider();

    await withPatchedHandleStartPlan(async () => ({
      outcome: "degraded",
      command: "/weave:start",
      message: "Degraded",
      hint: "Try something",
    }), async () => {
      const handler = buildStartPlanToolHandler(createDependencies(adapter));

      const result = await handler({ planName: "feature-auth" });

      expect(result).toContain("Degraded");
      expect(result).toContain("Try something");
    });
  });

  it("Should_return_message_only_when_degraded_outcome_has_no_hint", async () => {
    const adapter = new TestOpenCodeAdapter({ projectRoot: "C:/test-project" });
    await adapter.init();
    adapter.planStateProvider = makePlanStateProvider();

    await withPatchedHandleStartPlan(async () => ({
      outcome: "degraded",
      command: "/weave:start",
      message: "Degraded",
    }), async () => {
      const handler = buildStartPlanToolHandler(createDependencies(adapter));

      const result = await handler({ planName: "feature-auth" });

      expect(result).toBe("Degraded");
    });
  });

  it("Should_return_error_message_when_adapter_is_not_initialized", async () => {
    const adapter = new TestOpenCodeAdapter({ projectRoot: "C:/test-project" });
    const handler = buildStartPlanToolHandler(createDependencies(adapter));

    const result = await handler({ planName: "feature-auth" });

    expect(result).toContain("PlanStateProvider is unavailable");
    expect(result).toContain('call adapter.init() before starting plan "feature-auth"');
  });
});
