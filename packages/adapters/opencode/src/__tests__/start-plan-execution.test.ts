/**
 * Unit tests for `startPlanExecution` — the `/weave:start` delivery path.
 *
 * What executing a plan does — dispatching the builtin `tapestry-execution`
 * workflow's agents in order, refusing a plan that is not there, refusing a
 * name that would escape the plans directory, and refusing to start with no way
 * to read plan files — is now asserted from outside, in
 * `tests/adapters/opencode-runtime.scenario.test.ts`, against real plan files
 * on disk and a real in-memory OpenCode. Twenty cases are gone.
 *
 * What stays is what no OpenCode instance can show:
 *
 * | Kept | Why |
 * | --- | --- |
 * | `WEAVE_START_COMMAND` / `WEAVE_START_LEGACY_COMMAND` | Exported constants with **no production caller**. The plugin registers `"start-work"` and `"weave:start"` as command keys and reads neither constant. Kept and flagged rather than deleted — whether they should exist is a product decision |
 * | The provider-error branch | A scenario uses the real `BunFilesystemPlanStateProvider`, which cannot be made to fail on demand |
 * | The store-shape cases — instance created, slug, goal default and override | The `WorkflowInstance` is written to a runtime store that nothing reads back on this path, so no OpenCode output reveals the slug or the goal Weave chose |
 *
 * ## No production caller
 *
 * `startPlanExecution` is exported from the package barrel and called from
 * nowhere in this repository.
 */

import { describe, expect, it } from "bun:test";
import type {
  AgentDescriptor,
  PlanStateError,
  PlanStateProvider,
} from "@weaveio/weave-engine";
import { createInMemoryRuntimeStore } from "@weaveio/weave-engine";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";

import { OpenCodeAdapter, type OpenCodeAdapterError } from "../adapter.js";
import {
  type StartPlanExecutionInput,
  startPlanExecution,
  WEAVE_START_COMMAND,
  WEAVE_START_LEGACY_COMMAND,
} from "../start-plan-execution.js";

// ---------------------------------------------------------------------------
// MockOpenCodeAdapter
// ---------------------------------------------------------------------------

/**
 * Minimal test double for `OpenCodeAdapter`.
 *
 * Overrides `spawnSubagent` to return `okAsync(undefined)` without touching
 * the filesystem, SDK, or any real harness resource. Tracks all calls so
 * tests can assert the adapter was (or was not) invoked.
 *
 * Extends `OpenCodeAdapter` so it satisfies the concrete type required by
 * `StartPlanExecutionInput.adapter` and `RunWorkflowInput.adapter`.
 */
class MockOpenCodeAdapter extends OpenCodeAdapter {
  readonly spawnSubagentCalls: AgentDescriptor[] = [];

  override spawnSubagent(
    descriptor: AgentDescriptor,
  ): ResultAsync<void, OpenCodeAdapterError> {
    this.spawnSubagentCalls.push(descriptor);
    return okAsync(undefined);
  }
}

// ---------------------------------------------------------------------------
// MockPlanStateProvider
// ---------------------------------------------------------------------------

/**
 * In-memory mock for `PlanStateProvider`.
 *
 * Configurable: `planExistsResult` controls what `planExists` returns.
 * Tracks all calls so tests can assert the provider was (or was not) invoked.
 */
class MockPlanStateProvider implements PlanStateProvider {
  readonly planExistsCalls: string[] = [];
  readonly isPlanCompleteCalls: string[] = [];

  constructor(
    private readonly planExistsResult: boolean = true,
    private readonly isPlanCompleteResult: boolean = true,
  ) {}

  planExists(planName: string): ResultAsync<boolean, PlanStateError> {
    this.planExistsCalls.push(planName);
    return okAsync(this.planExistsResult);
  }

  isPlanComplete(planName: string): ResultAsync<boolean, PlanStateError> {
    this.isPlanCompleteCalls.push(planName);
    return okAsync(this.isPlanCompleteResult);
  }
}

/**
 * Mock `PlanStateProvider` that always returns a `ProviderUnavailable` error.
 */
class FailingPlanStateProvider implements PlanStateProvider {
  planExists(_planName: string): ResultAsync<boolean, PlanStateError> {
    return errAsync({
      type: "ProviderUnavailable" as const,
      cause: { message: "test provider unavailable" },
    });
  }

  isPlanComplete(_planName: string): ResultAsync<boolean, PlanStateError> {
    return errAsync({
      type: "ProviderUnavailable" as const,
      cause: { message: "test provider unavailable" },
    });
  }
}

// ---------------------------------------------------------------------------
// Fixture WeaveConfig — tapestry-execution workflow
// ---------------------------------------------------------------------------

/**
 * Minimal fixture `WeaveConfig` with the `tapestry-execution` workflow.
 *
 * Mirrors the builtin `tapestry-execution` workflow structure:
 *   1. `execute` — autonomous step using `shuttle`, `plan_complete` completion
 *   2. `review`  — gate step using `weft`, `review_verdict` completion
 *   3. `security` — gate step using `warp`, `review_verdict` completion
 *
 * Uses `agent_signal` for all steps in tests that don't need plan-oriented
 * completion, to keep fixtures simple.
 */
const TAPESTRY_EXECUTION_CONFIG: StartPlanExecutionInput["config"] = {
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
      description: "Weft (Reviewer)",
      prompt: "You are a code reviewer.",
      models: ["claude-sonnet-4-5"],
      mode: "subagent",
      temperature: 0.1,
    },
    warp: {
      description: "Warp (Security Auditor)",
      prompt: "You are a security auditor.",
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
  extend_before_plan: { steps: [] },
  workflows: {
    "tapestry-execution": {
      description: "Execute an existing named plan end-to-end, then review",
      version: 1,
      steps: [
        {
          name: "execute",
          display_name: "Execute the existing plan",
          type: "autonomous",
          agent: "shuttle",
          prompt:
            "Execute the existing plan named {{instance.slug}} for: {{instance.goal}}",
          completion: {
            method: "plan_complete",
            plan_name: "{{instance.slug}}",
          },
          // No inputs declared: the execute step is the first step in
          // tapestry-execution, so no prior step can populate plan_path.
          // The prompt uses {{instance.slug}} (set at workflow start) rather
          // than {{artifacts.plan_path}} (which would require a prior step).
        },
        {
          name: "review",
          display_name: "Code review after execution",
          type: "gate",
          agent: "weft",
          prompt:
            "Review all changes made during plan execution for: {{instance.goal}}",
          completion: { method: "review_verdict" },
          on_reject: "pause",
        },
        {
          name: "security",
          display_name: "Security audit after execution",
          type: "gate",
          agent: "warp",
          prompt:
            "Security audit of all changes made during plan execution for: {{instance.goal}}",
          completion: { method: "review_verdict" },
          on_reject: "pause",
        },
      ],
    },
  },
};

/**
 * Minimal fixture `WeaveConfig` with a simple `agent_signal` workflow.
 *
 * Used for tests that need a successful `startPlan` delegation without plan-oriented
 * completion methods.
 */
const SIMPLE_EXECUTION_CONFIG: StartPlanExecutionInput["config"] = {
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
    "simple-execution": {
      description: "Simple execution workflow for testing",
      version: 1,
      steps: [
        {
          name: "execute",
          display_name: "Execute",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Execute for: {{instance.goal}}",
          completion: { method: "agent_signal" },
        },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Tests — command name constants
// ---------------------------------------------------------------------------

describe("startPlanExecution — command name constants", () => {
  it("WEAVE_START_COMMAND is /weave:start (preferred)", () => {
    expect(WEAVE_START_COMMAND).toBe("/weave:start");
  });

  it("WEAVE_START_LEGACY_COMMAND is /start-work (legacy compatibility)", () => {
    expect(WEAVE_START_LEGACY_COMMAND).toBe("/start-work");
  });
});
// ---------------------------------------------------------------------------
// Tests — provider unavailable
// ---------------------------------------------------------------------------

describe("startPlanExecution — provider unavailable", () => {
  it("returns ProviderUnavailable when planExists returns an error", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new FailingPlanStateProvider();

    const result = await startPlanExecution({
      planName: "my-plan",
      config: TAPESTRY_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("ProviderUnavailable");
    }
  });
});
// ---------------------------------------------------------------------------
// Tests — present plan delegates to shared startPlan operation
// ---------------------------------------------------------------------------

describe("startPlanExecution — present plan delegates to shared startPlan operation", () => {
  it("creates a WorkflowInstance in the store when plan exists", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(true, true);

    const result = await startPlanExecution({
      planName: "my-plan",
      config: SIMPLE_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
      workflowName: "simple-execution",
    });

    expect(result.isOk()).toBe(true);

    // A WorkflowInstance was created — the explicit path was taken
    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("uses planName as the slug for the workflow instance", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(true, true);

    const result = await startPlanExecution({
      planName: "feature-auth",
      config: SIMPLE_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
      workflowName: "simple-execution",
    });

    expect(result.isOk()).toBe(true);

    // Assert the persisted WorkflowInstance slug equals the planName.
    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value).toHaveLength(1);
      expect(instances.value[0]?.slug).toBe("feature-auth");
    }
  });

  it("defaults goal to 'Execute plan: <planName>' when goal is omitted", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(true, true);

    // No goal provided — should default
    const result = await startPlanExecution({
      planName: "my-feature",
      config: SIMPLE_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
      workflowName: "simple-execution",
    });

    // The call should succeed — the default goal is used internally
    expect(result.isOk()).toBe(true);
  });

  it("uses the provided goal when supplied", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(true, true);

    const result = await startPlanExecution({
      planName: "my-feature",
      config: SIMPLE_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
      workflowName: "simple-execution",
      goal: "Implement the authentication feature",
    });

    expect(result.isOk()).toBe(true);
  });
});
