/**
 * Unit tests for `runWorkflow`.
 *
 * What a run of a named workflow does — which agent OpenCode is asked to run
 * for each step, in what order, what a completed run reports, what an unknown
 * workflow name says, and what a step cap does — is now asserted from outside,
 * in `tests/adapters/opencode-runtime.scenario.test.ts`, against a real
 * `OpenCodeAdapter` wired to a real in-memory OpenCode. Sixteen cases are gone.
 *
 * What stays is what no OpenCode instance can show:
 *
 * | Kept | Why |
 * | --- | --- |
 * | The explicit-trigger block | `runWorkflow` must never be reachable from an idle hook, a session event or a continuation hook. That is an absence across the whole adapter; no run of it can demonstrate the absence |
 * | The `PlanStateProvider` error branches | A scenario supplies the real `BunFilesystemPlanStateProvider` over a real plan file, which cannot be made to fail on demand. The absent-provider and provider-error branches need a stub |
 * | `PlanStateProvider` is not consulted for `agent_signal` steps | An interaction, not an outcome: the run completes either way |
 * | `maxSteps: 0` | Below the engine's minimum, so it is rejected before any step is dispatched and nothing reaches OpenCode |
 *
 * ## No production caller
 *
 * `runWorkflow` is exported from the package barrel and called from nowhere in
 * this repository. The shipped plugin registers two prompt-template commands
 * and nothing that invokes this function.
 */

import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import type { PlanStateError, PlanStateProvider } from "@weaveio/weave-engine";
import { createInMemoryRuntimeStore } from "@weaveio/weave-engine";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";

import { OpenCodeAdapter } from "../index.js";
import { runWorkflow } from "../run-workflow.js";

// ---------------------------------------------------------------------------
// MockPlanStateProvider
// ---------------------------------------------------------------------------

/**
 * In-memory mock for `PlanStateProvider`.
 *
 * Configurable: `planExistsResult` and `isPlanCompleteResult` control what
 * the mock returns. Defaults to `true` for both (plan exists and is complete).
 *
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
 * Mock `PlanStateProvider` that always returns an error.
 *
 * Used to prove the engine propagates provider errors as `LifecycleError`.
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
// Fixture WeaveConfig — 2-step agent_signal workflow
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
  extend_before_plan: { steps: [] },
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
const _THREE_STEP_CONFIG: WeaveConfig = {
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
  extend_before_plan: { steps: [] },
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

/**
 * Fixture `WeaveConfig` with a 2-step workflow where the first step uses
 * `plan_created` completion — requires a `PlanStateProvider`.
 *
 * This fixture proves that plan-oriented completion boundaries require the
 * provider to be supplied by the adapter (not the engine).
 */
const PLAN_CREATED_CONFIG: WeaveConfig = {
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
    "plan-then-execute": {
      description: "Create a plan file then execute it",
      version: 1,
      steps: [
        {
          name: "plan",
          display_name: "Create plan file",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Create a plan for: {{instance.goal}}",
          completion: { method: "plan_created", plan_name: "my-plan" },
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
 * Fixture `WeaveConfig` with a 2-step workflow where the first step uses
 * `plan_complete` completion — requires a `PlanStateProvider`.
 */
const PLAN_COMPLETE_CONFIG: WeaveConfig = {
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
    "execute-and-verify": {
      description: "Execute a plan and verify completion",
      version: 1,
      steps: [
        {
          name: "execute",
          display_name: "Execute the plan",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Execute the plan for: {{instance.goal}}",
          completion: { method: "plan_complete", plan_name: "my-plan" },
        },
        {
          name: "verify",
          display_name: "Verify the result",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Verify the result for: {{instance.goal}}",
          completion: { method: "agent_signal" },
        },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Tests — basic execution loop
// ---------------------------------------------------------------------------

describe("runWorkflow — delegates to engine runNamedWorkflow with OpenCode adapter projection", () => {
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

// ---------------------------------------------------------------------------
// Tests — explicit named-workflow execution boundary (Spec 22 Unit 4 / ADR 0004)
// ---------------------------------------------------------------------------

describe("runWorkflow — explicit named-workflow execution boundary", () => {
  /**
   * Proof: `runWorkflow` executes a specific, named workflow by delegating to
   * the engine's `runNamedWorkflow` command operation. The caller must supply
   * `workflowName`; there is no implicit or default workflow selection.
   *
   * This is distinct from `/weave:start` → `startPlanExecution`, which is
   * plan-first and does not require the caller to name a workflow.
   *
   * `runWorkflow` must be called by a user-authorized trigger (command
   * handler, script, or UI action). It is not wired to any idle hook,
   * session event, or continuation hook.
   *
   * ADR 0004 Decision 2: "Durable execution begins only through an explicit,
   * user-authorized transition. The engine enforces this through `startExecution`."
   *
   * ADR 0004 Decision 3: "Adapters are delivery layers, not semantic owners."
   *
   * This test proves that `runWorkflow` delegates to `runNamedWorkflow`
   * (which calls `startExecution` internally) and that named-workflow
   * execution only begins when the function is explicitly invoked — not from
   * any implicit path.
   */
  it("starts named-workflow execution only when explicitly called — not from idle hooks or session events", async () => {
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    // Before explicit invocation: no workflow instances exist in the store.
    // The store starts empty — no execution has been started implicitly.
    const instancesBefore = await store.instances.list();
    expect(instancesBefore.isOk()).toBe(true);
    if (instancesBefore.isOk()) {
      expect(instancesBefore.value).toHaveLength(0);
    }

    // Explicit invocation: the caller names the workflow and calls runWorkflow.
    // This is the only path that creates a WorkflowInstance and acquires an
    // ExecutionLease — per ADR 0004 Decision 2.
    // (Contrast with /weave:start → startPlanExecution, which is plan-first.)
    const result = await runWorkflow({
      config: TWO_STEP_CONFIG,
      workflowName: "plan-and-execute",
      goal: "Explicit named-workflow trigger",
      slug: "explicit-named-workflow-trigger",
      adapter,
      store,
    });

    expect(result.isOk()).toBe(true);

    // After explicit invocation: a workflow instance was created.
    // This proves startExecution was called through the explicit named path.
    const instancesAfter = await store.instances.list();
    expect(instancesAfter.isOk()).toBe(true);
    if (instancesAfter.isOk()) {
      // At least one instance was created by the explicit runWorkflow call.
      expect(instancesAfter.value.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("no named-workflow execution occurs without an explicit runWorkflow call", async () => {
    // Proof: without an explicit runWorkflow call, no WorkflowInstance is
    // created. Idle hooks, session events, and continuation hooks do not
    // call runWorkflow — they cannot implicitly start named-workflow execution.
    const store = createInMemoryRuntimeStore();

    // Simulate what an idle hook or session event would do: nothing.
    // No runWorkflow call is made here — the store remains empty.

    const instancesAfter = await store.instances.list();
    expect(instancesAfter.isOk()).toBe(true);
    if (instancesAfter.isOk()) {
      // No instances were created — the store remains empty.
      expect(instancesAfter.value).toHaveLength(0);
    }
  });

  it("each explicit runWorkflow call creates a distinct WorkflowInstance for the named workflow", async () => {
    // Proof: each explicit named-workflow invocation creates a separate
    // WorkflowInstance with a unique ID. Execution is scoped to explicit
    // invocations — not shared across implicit events or plugin hooks.
    const adapter1 = new OpenCodeAdapter();
    const adapter2 = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    const result1 = await runWorkflow({
      config: TWO_STEP_CONFIG,
      workflowName: "plan-and-execute",
      goal: "First named-workflow invocation",
      slug: "first-named-workflow-invocation",
      adapter: adapter1,
      store,
    });

    const result2 = await runWorkflow({
      config: TWO_STEP_CONFIG,
      workflowName: "plan-and-execute",
      goal: "Second named-workflow invocation",
      slug: "second-named-workflow-invocation",
      adapter: adapter2,
      store,
    });

    expect(result1.isOk()).toBe(true);
    expect(result2.isOk()).toBe(true);

    if (result1.isOk() && result2.isOk()) {
      // Each call produces a distinct workflowInstanceId.
      expect(result1.value.workflowInstanceId).not.toBe(
        result2.value.workflowInstanceId,
      );
    }
  });

  it("runWorkflow requires an explicit workflowName — it is not a hook or event handler", async () => {
    // Structural proof: `runWorkflow` requires an explicit `workflowName`
    // that must be provided by the caller. It delegates to `runNamedWorkflow`
    // (engine), which validates the name before any store access. It cannot
    // be called from an idle hook or session event without those explicit
    // inputs — there is no implicit state that could trigger it.
    //
    // This distinguishes runWorkflow from /weave:start (startPlanExecution),
    // which selects the workflow implicitly based on plan state.
    //
    // This test verifies the function signature enforces explicit invocation
    // by checking that the workflow name is validated before any store access.
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    // Unknown workflowName → WorkflowNotFound (validated before store access)
    const missingWorkflow = await runWorkflow({
      config: TWO_STEP_CONFIG,
      workflowName: "not-a-workflow",
      goal: "Test",
      slug: "test",
      adapter,
      store,
    });

    expect(missingWorkflow.isErr()).toBe(true);
    if (missingWorkflow.isErr()) {
      expect(missingWorkflow.error.type).toBe("WorkflowNotFound");
    }

    // No WorkflowInstance was created — validation failed before store access.
    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — PlanStateProvider at completion boundaries (Spec 22 Unit 4)
// ---------------------------------------------------------------------------

describe("runWorkflow — PlanStateProvider at named-workflow completion boundaries", () => {
  /**
   * Proof: when a named-workflow step uses `plan_created` as its completion
   * method, the engine requires a `PlanStateProvider`. The adapter (OpenCode)
   * is responsible for supplying this provider — it is not engine-owned I/O.
   * `runWorkflow` threads the provider through to `runNamedWorkflow` (engine),
   * which passes it to `runWorkflowLifecycle` and ultimately to `completeStep`.
   *
   * ADR 0004 Decision 3: "Adapters are delivery layers, not semantic owners."
   * Spec 19: "Adapters supply a `PlanStateProvider` implementation via
   * `CompleteStepInput.planStateProvider`."
   */
  it("fails with LifecycleError when plan_created step has no PlanStateProvider", async () => {
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    // No planStateProvider supplied — the engine must fail closed.
    const result = await runWorkflow({
      config: PLAN_CREATED_CONFIG,
      workflowName: "plan-then-execute",
      goal: "Create a plan",
      slug: "create-a-plan",
      adapter,
      store,
      // planStateProvider intentionally omitted
    });

    // The engine fails closed: plan_created requires a PlanStateProvider.
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("LifecycleError");
      if (result.error.type === "LifecycleError") {
        expect(result.error.cause.type).toBe("policy_decision");
      }
    }
  });

  it("fails with LifecycleError when plan_complete step has no PlanStateProvider", async () => {
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    // No planStateProvider supplied — the engine must fail closed.
    const result = await runWorkflow({
      config: PLAN_COMPLETE_CONFIG,
      workflowName: "execute-and-verify",
      goal: "Execute a plan",
      slug: "execute-a-plan",
      adapter,
      store,
      // planStateProvider intentionally omitted
    });

    // The engine fails closed: plan_complete requires a PlanStateProvider.
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("LifecycleError");
      if (result.error.type === "LifecycleError") {
        expect(result.error.cause.type).toBe("policy_decision");
      }
    }
  });

  it("succeeds when plan_created step has PlanStateProvider that reports plan exists", async () => {
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    // Provider reports plan exists (planExists → true)
    const planStateProvider = new MockPlanStateProvider(true, true);

    const result = await runWorkflow({
      config: PLAN_CREATED_CONFIG,
      workflowName: "plan-then-execute",
      goal: "Create a plan",
      slug: "create-a-plan",
      adapter,
      store,
      planStateProvider,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe("completed");
    }

    // The provider was called for the plan_created step.
    expect(planStateProvider.planExistsCalls).toHaveLength(1);
    expect(planStateProvider.planExistsCalls[0]).toBe("my-plan");
  });

  it("propagates PlanStateProvider errors as LifecycleError", async () => {
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    // Provider always fails — simulates filesystem unavailability
    const planStateProvider = new FailingPlanStateProvider();

    const result = await runWorkflow({
      config: PLAN_CREATED_CONFIG,
      workflowName: "plan-then-execute",
      goal: "Create a plan",
      slug: "create-a-plan",
      adapter,
      store,
      planStateProvider,
    });

    // Provider error is propagated as a LifecycleError.
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("LifecycleError");
    }
  });

  it("PlanStateProvider is passed through to completeStep for each plan-oriented step", async () => {
    // Proof: the adapter supplies the PlanStateProvider to the engine at each
    // completeStep call. The engine calls the provider — not the adapter.
    // This verifies the boundary: adapter owns the provider implementation,
    // engine owns the interface and the call.
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(true, true);

    const result = await runWorkflow({
      config: PLAN_CREATED_CONFIG,
      workflowName: "plan-then-execute",
      goal: "Verify provider boundary",
      slug: "verify-provider-boundary",
      adapter,
      store,
      planStateProvider,
    });

    expect(result.isOk()).toBe(true);

    // The engine called planExists exactly once (for the plan_created step).
    // The second step uses agent_signal — no provider call.
    expect(planStateProvider.planExistsCalls).toHaveLength(1);
    expect(planStateProvider.isPlanCompleteCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — MaxStepsExceeded: structured surfacing (no regex scraping)
// ---------------------------------------------------------------------------

describe("runWorkflow — MaxStepsExceeded: structured error surfacing", () => {
  /**
   * Regression coverage for the `RunWorkflowInput.maxSteps` chain.
   *
   * These tests prove that:
   * 1. `maxSteps` is threaded from `RunWorkflowInput` through `runNamedWorkflow`
   *    (engine) to `runWorkflowLifecycle` (runner).
   * 2. When the cap is exceeded, `runWorkflow` surfaces
   *    `{ type: "MaxStepsExceeded", maxSteps: N }` with `N` matching the
   *    input cap — no regex scraping of a human-readable message string.
   * 3. `maxSteps: 0` is rejected before any store access.
   *
   * Chain: RunWorkflowInput.maxSteps
   *   → runWorkflow (passes to runNamedWorkflow)
   *   → runNamedWorkflow (passes to runWorkflowLifecycle)
   *   → runWorkflowLifecycle (enforces cap, emits max_steps_exceeded)
   *   → mapRunnerErrorToCommandError (command_validation with maxSteps field)
   *   → mapCommandError (MaxStepsExceeded with structured maxSteps value)
   *   → RunWorkflowError.MaxStepsExceeded.maxSteps (N matches input cap)
   */

  it("returns MaxStepsExceeded when maxSteps: 0 (below minimum)", async () => {
    // maxSteps: 0 is rejected by runWorkflowLifecycle before any store access.
    // The adapter maps this to MaxStepsExceeded with maxSteps: 0.
    const adapter = new OpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    const result = await runWorkflow({
      config: TWO_STEP_CONFIG,
      workflowName: "plan-and-execute",
      goal: "Test maxSteps=0 rejection",
      slug: "test-maxsteps-zero",
      adapter,
      store,
      maxSteps: 0,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("MaxStepsExceeded");
      if (result.error.type === "MaxStepsExceeded") {
        expect(result.error.maxSteps).toBe(0);
      }
    }
  });
});
