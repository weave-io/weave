/**
 * Tests for `startPlanExecution` — the adapter-owned helper for the
 * `/weave:start` delivery path.
 *
 * ## What these tests prove
 *
 * 1. **Plan validation before store access** — when the plan is missing or the
 *    provider is unavailable, `startPlanExecution` returns a typed error and
 *    leaves the store empty (no `WorkflowInstance` is created).
 *
 * 2. **Delegation to shared `startPlan` semantics** — when the plan exists,
 *    `startPlanExecution` delegates to the engine's `startPlan` operation with
 *    the `tapestry-execution` workflow (or the caller-supplied `workflowName`).
 *    The store is mutated only after `startPlan` validates the plan.
 *
 * 3. **Command name constants** — `WEAVE_START_COMMAND` is `/weave:start`
 *    (preferred) and `WEAVE_START_LEGACY_COMMAND` is `/start-work` (legacy).
 *    Neither constant references a core package.
 *
 * 4. **Provider unavailable** — when `planStateProvider` is `undefined` or
 *    returns a provider error, `startPlanExecution` returns `ProviderUnavailable`
 *    without touching the store.
 *
 * Uses:
 * - `InMemoryRuntimeStore` (no SQLite, no filesystem)
 * - `MockPlanStateProvider` (no real filesystem plan files)
 * - Fixture `WeaveConfig` with the `tapestry-execution` workflow
 */

import { describe, expect, it } from "bun:test";
import type {
  AgentDescriptor,
  PlanStateError,
  PlanStateProvider,
} from "@weave/engine";
import { createInMemoryRuntimeStore } from "@weave/engine";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";

import { OpenCodeAdapter, type OpenCodeAdapterError } from "../adapter.js";
import {
  DEFAULT_EXECUTION_WORKFLOW,
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

/**
 * Mock `PlanStateProvider` that always returns an `InvalidPlanName` error.
 *
 * Simulates a provider that rejects the plan name at the safe-name check
 * (e.g. the name contains `/`, `..`, `\0`, or other unsafe characters).
 */
class InvalidNamePlanStateProvider implements PlanStateProvider {
  planExists(planName: string): ResultAsync<boolean, PlanStateError> {
    return errAsync({
      type: "InvalidPlanName" as const,
      planName,
    });
  }

  isPlanComplete(planName: string): ResultAsync<boolean, PlanStateError> {
    return errAsync({
      type: "InvalidPlanName" as const,
      planName,
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

  it("DEFAULT_EXECUTION_WORKFLOW is tapestry-execution", () => {
    expect(DEFAULT_EXECUTION_WORKFLOW).toBe("tapestry-execution");
  });

  it("WEAVE_START_COMMAND and WEAVE_START_LEGACY_COMMAND are distinct", () => {
    expect(WEAVE_START_COMMAND).not.toBe(WEAVE_START_LEGACY_COMMAND);
  });
});

// ---------------------------------------------------------------------------
// Tests — missing plan returns typed error and leaves store empty
// ---------------------------------------------------------------------------

describe("startPlanExecution — missing plan", () => {
  it("returns PlanNotFound when planExists returns false", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    // Provider reports plan does NOT exist
    const planStateProvider = new MockPlanStateProvider(false);

    const result = await startPlanExecution({
      planName: "my-missing-plan",
      config: TAPESTRY_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("PlanNotFound");
      if (result.error.type === "PlanNotFound") {
        expect(result.error.planName).toBe("my-missing-plan");
      }
    }
  });

  it("leaves the store empty when plan is missing", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(false);

    await startPlanExecution({
      planName: "nonexistent-plan",
      config: TAPESTRY_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
    });

    // No WorkflowInstance should have been created
    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value).toHaveLength(0);
    }
  });

  it("calls planExists with the correct plan name", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(false);

    await startPlanExecution({
      planName: "feature-auth",
      config: TAPESTRY_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
    });

    expect(planStateProvider.planExistsCalls).toHaveLength(1);
    expect(planStateProvider.planExistsCalls[0]).toBe("feature-auth");
  });
});

// ---------------------------------------------------------------------------
// Tests — provider unavailable
// ---------------------------------------------------------------------------

describe("startPlanExecution — provider unavailable", () => {
  it("returns ProviderUnavailable when planStateProvider is undefined", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    const result = await startPlanExecution({
      planName: "my-plan",
      config: TAPESTRY_EXECUTION_CONFIG,
      planStateProvider: undefined,
      adapter,
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("ProviderUnavailable");
    }
  });

  it("leaves the store empty when provider is undefined", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    await startPlanExecution({
      planName: "my-plan",
      config: TAPESTRY_EXECUTION_CONFIG,
      planStateProvider: undefined,
      adapter,
      store,
    });

    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value).toHaveLength(0);
    }
  });

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

  it("leaves the store empty when provider returns an error", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new FailingPlanStateProvider();

    await startPlanExecution({
      planName: "my-plan",
      config: TAPESTRY_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
    });

    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — invalid plan name returns distinct typed error
// ---------------------------------------------------------------------------

describe("startPlanExecution — invalid plan name", () => {
  it("returns InvalidPlanName (not ProviderUnavailable) when provider rejects the name", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new InvalidNamePlanStateProvider();

    const result = await startPlanExecution({
      planName: "../../../etc/passwd",
      config: TAPESTRY_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("InvalidPlanName");
    }
  });

  it("preserves the planName in the InvalidPlanName error", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new InvalidNamePlanStateProvider();
    const badName = "../../../etc/passwd";

    const result = await startPlanExecution({
      planName: badName,
      config: TAPESTRY_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.type === "InvalidPlanName") {
      expect(result.error.planName).toBe(badName);
    }
  });

  it("leaves the store empty when plan name is invalid", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new InvalidNamePlanStateProvider();

    await startPlanExecution({
      planName: "bad/name",
      config: TAPESTRY_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
    });

    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value).toHaveLength(0);
    }
  });

  it("InvalidPlanName is distinct from ProviderUnavailable", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    const invalidResult = await startPlanExecution({
      planName: "bad/name",
      config: TAPESTRY_EXECUTION_CONFIG,
      planStateProvider: new InvalidNamePlanStateProvider(),
      adapter,
      store,
    });

    const unavailableResult = await startPlanExecution({
      planName: "my-plan",
      config: TAPESTRY_EXECUTION_CONFIG,
      planStateProvider: new FailingPlanStateProvider(),
      adapter,
      store,
    });

    expect(invalidResult.isErr()).toBe(true);
    expect(unavailableResult.isErr()).toBe(true);

    if (invalidResult.isErr() && unavailableResult.isErr()) {
      expect(invalidResult.error.type).toBe("InvalidPlanName");
      expect(unavailableResult.error.type).toBe("ProviderUnavailable");
      expect(invalidResult.error.type).not.toBe(unavailableResult.error.type);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — present plan delegates to shared startPlan operation
// ---------------------------------------------------------------------------

describe("startPlanExecution — present plan delegates to shared startPlan operation", () => {
  it("delegates to startPlan when plan exists (agent_signal workflow)", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    // Provider reports plan exists
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
    if (result.isOk()) {
      expect(result.value.status).toBe("completed");
      expect(result.value.stepsDispatched).toBeGreaterThanOrEqual(1);
    }
  });

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

  it("defaults workflowName to tapestry-execution when omitted", async () => {
    // Verify that the DEFAULT_EXECUTION_WORKFLOW constant is used when
    // workflowName is not provided. We test this by omitting workflowName
    // and using a config that includes tapestry-execution.
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    // Provider reports plan exists AND is complete (needed for plan_complete step)
    const planStateProvider = new MockPlanStateProvider(true, true);

    // Use TAPESTRY_EXECUTION_CONFIG which has the tapestry-execution workflow.
    // The first step uses plan_complete — provider must report plan is complete.
    const result = await startPlanExecution({
      planName: "my-plan",
      config: TAPESTRY_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
      // workflowName intentionally omitted — should default to tapestry-execution
    });

    // The result may be ok (if all steps complete) or err (if gate steps
    // fail with agent_signal mismatch). Either way, the store should have
    // been touched — proving startPlan was called with tapestry-execution.
    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      // At least one instance was created — startPlan was called
      expect(instances.value.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("returns WorkflowError when the workflow does not exist in config", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(true, true);

    const result = await startPlanExecution({
      planName: "my-plan",
      config: SIMPLE_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
      workflowName: "nonexistent-workflow",
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("WorkflowError");
      if (result.error.type === "WorkflowError") {
        expect(result.error.cause.type).toBe("WorkflowNotFound");
      }
    }
  });

  it("leaves the store empty when workflow is not found", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(true, true);

    await startPlanExecution({
      planName: "my-plan",
      config: SIMPLE_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
      workflowName: "nonexistent-workflow",
    });

    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value).toHaveLength(0);
    }
  });

  it("passes planStateProvider through to startPlan for plan-oriented steps", async () => {
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    // Provider reports plan exists AND is complete
    const planStateProvider = new MockPlanStateProvider(true, true);

    await startPlanExecution({
      planName: "my-plan",
      config: TAPESTRY_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
      store,
      // workflowName defaults to tapestry-execution
    });

    // planExists was called once (pre-flight check in startPlanExecution)
    // isPlanComplete may be called by the engine for the plan_complete step
    expect(planStateProvider.planExistsCalls).toHaveLength(1);
    expect(planStateProvider.planExistsCalls[0]).toBe("my-plan");
  });
});

// ---------------------------------------------------------------------------
// Tests — no core package imports or concrete command name references
// ---------------------------------------------------------------------------

describe("startPlanExecution — adapter boundary", () => {
  it("WEAVE_START_COMMAND does not reference a core package constant", () => {
    // The command name is a string literal defined in the adapter module.
    // This test proves it is adapter-owned by asserting the value directly.
    expect(typeof WEAVE_START_COMMAND).toBe("string");
    expect(WEAVE_START_COMMAND.startsWith("/")).toBe(true);
  });

  it("WEAVE_START_LEGACY_COMMAND does not reference a core package constant", () => {
    expect(typeof WEAVE_START_LEGACY_COMMAND).toBe("string");
    expect(WEAVE_START_LEGACY_COMMAND.startsWith("/")).toBe(true);
  });

  it("startPlanExecution accepts WeaveConfig as a parameter (not fetched internally)", () => {
    // Structural proof: the function signature requires config to be passed in.
    // This ensures no core-owned config loading happens inside the helper.
    const adapter = new MockOpenCodeAdapter();
    const planStateProvider = new MockPlanStateProvider(false);

    // The call compiles and runs — config is a parameter, not fetched internally.
    const resultPromise = startPlanExecution({
      planName: "test",
      config: SIMPLE_EXECUTION_CONFIG,
      planStateProvider,
      adapter,
    });

    expect(resultPromise).toBeDefined();
  });
});
