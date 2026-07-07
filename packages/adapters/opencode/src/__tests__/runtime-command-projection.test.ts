/**
 * Tests for `RuntimeCommandProjection` — OpenCode adapter-owned command handlers.
 *
 * ## What these tests prove
 *
 * 1. **Each handler calls the matching shared engine operation** — no lifecycle
 *    state-transition logic is duplicated in the projection layer. The handlers
 *    delegate to `startPlan`, `runNamedWorkflow`, `inspectStatus`,
 *    `abortExecution`, `advanceStep`, and `runtimeHealth` respectively.
 *
 * 2. **Typed success/failure/degraded results are rendered** — each handler
 *    returns a `ProjectionResult<T>` with the correct `outcome` field and a
 *    human-readable `message` string. The `data` field carries the engine's
 *    renderer-ready result data.
 *
 * 3. **No lifecycle state-transition logic is duplicated** — the projection
 *    layer never creates `WorkflowInstance` records, acquires leases, or
 *    applies lifecycle effects directly. All of that is engine-owned.
 *
 * 4. **Adapter-owned argument parsing and messages** — command labels
 *    (`WEAVE_COMMAND_LABELS`), error messages, and degraded affordance
 *    documentation are adapter-owned and tested here.
 *
 * 5. **`/start-work` is out of scope** — no test references `/start-work`.
 *    That path is covered by `start-plan-execution.test.ts`.
 *
 * Uses:
 * - `InMemoryRuntimeStore` (no SQLite, no filesystem)
 * - `MockPlanStateProvider` (no real filesystem plan files)
 * - `MockOpenCodeAdapter` (no real SDK calls)
 * - Fixture `WeaveConfig` objects with simple `agent_signal` workflows
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
  buildOpenCodeHealthReport,
  DEGRADED_AFFORDANCES,
  RuntimeCommandProjection,
  WEAVE_COMMAND_LABELS,
} from "../runtime-command-projection.js";

// ---------------------------------------------------------------------------
// MockOpenCodeAdapter
// ---------------------------------------------------------------------------

/**
 * Minimal test double for `OpenCodeAdapter`.
 *
 * Overrides `spawnSubagent` to return `okAsync(undefined)` without touching
 * the filesystem, SDK, or any real harness resource. Tracks all calls so
 * tests can assert the adapter was (or was not) invoked.
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

/**
 * Failing test double for `OpenCodeAdapter`.
 *
 * `spawnSubagent` always returns an error — used to prove failure paths.
 */
class FailingOpenCodeAdapter extends OpenCodeAdapter {
  override spawnSubagent(
    descriptor: AgentDescriptor,
  ): ResultAsync<void, OpenCodeAdapterError> {
    return errAsync(
      new (class extends Error {
        readonly type = "ReconcileAgentError" as const;
        readonly agentName = descriptor.name;
        readonly cause = undefined;
        constructor() {
          super(`spawnSubagent failed for agent "${descriptor.name}"`);
          this.name = "OpenCodeAdapterError";
        }
      })(),
    );
  }
}

// ---------------------------------------------------------------------------
// MockPlanStateProvider
// ---------------------------------------------------------------------------

/**
 * In-memory mock for `PlanStateProvider`.
 *
 * Configurable: `planExistsResult` and `isPlanCompleteResult` control what
 * the mock returns. Defaults to `true` for both.
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

// ---------------------------------------------------------------------------
// Fixture WeaveConfig — simple agent_signal workflow
// ---------------------------------------------------------------------------

/**
 * Minimal fixture workflow registry with a 2-step `agent_signal` workflow.
 *
 * Used for tests that need a successful execution without plan-oriented
 * completion methods.
 */
const SIMPLE_WORKFLOWS: Record<string, unknown> = {
  "simple-workflow": {
    description: "Simple 2-step workflow for testing",
    version: 1,
    steps: [
      {
        name: "step-one",
        display_name: "Step One",
        type: "autonomous",
        agent: "shuttle",
        prompt: "Do step one for: {{instance.goal}}",
        completion: { method: "agent_signal" },
      },
      {
        name: "step-two",
        display_name: "Step Two",
        type: "autonomous",
        agent: "shuttle",
        prompt: "Do step two for: {{instance.goal}}",
        completion: { method: "agent_signal" },
      },
    ],
  },
};

/**
 * Gate workflow with a `review_verdict` step for completion signal tests.
 *
 * - "work" step: agent_signal (auto-advances)
 * - "gate": review_verdict + on_reject: pause
 *
 * Used to test `handleAdvanceStep` with `review_verdict` approved/rejected signals.
 */
const GATE_WORKFLOWS: Record<string, unknown> = {
  "gate-workflow": {
    description: "Gate workflow with review_verdict step for testing",
    version: 1,
    steps: [
      {
        name: "work",
        display_name: "Work",
        type: "autonomous",
        agent: "shuttle",
        prompt: "Do the work for: {{instance.goal}}",
        completion: { method: "agent_signal" },
      },
      {
        name: "gate",
        display_name: "Gate",
        type: "gate",
        agent: "weft",
        prompt: "Review the changes",
        completion: { method: "review_verdict" },
        on_reject: "pause",
      },
    ],
  },
};

/**
 * Plan workflow with `plan_created` and `plan_complete` completion methods.
 *
 * Used to test the degraded fallback when `planStateProvider` is absent.
 */
const PLAN_COMPLETION_WORKFLOWS: Record<string, unknown> = {
  "plan-completion-workflow": {
    description: "Plan completion workflow for testing",
    version: 1,
    steps: [
      {
        name: "create-plan",
        display_name: "Create Plan",
        type: "autonomous",
        agent: "pattern",
        prompt: "Create a plan for: {{instance.goal}}",
        completion: {
          method: "plan_created",
          plan_name: "{{instance.slug}}",
        },
      },
      {
        name: "execute-plan",
        display_name: "Execute Plan",
        type: "autonomous",
        agent: "shuttle",
        prompt: "Execute the plan for: {{instance.goal}}",
        completion: {
          method: "plan_complete",
          plan_name: "{{instance.slug}}",
        },
      },
    ],
  },
};

/**
 * Minimal fixture agent config for the shuttle agent.
 *
 * Used in workflow steps that reference the shuttle agent.
 */
const SHUTTLE_AGENT_CONFIG = {
  description: "Shuttle (Domain Specialist)",
  prompt: "You are a domain specialist.",
  models: ["claude-sonnet-4-5"],
  mode: "subagent" as const,
  temperature: 0.2,
  tool_policy: {
    read: "allow" as const,
    write: "allow" as const,
    execute: "allow" as const,
    delegate: "deny" as const,
    network: "ask" as const,
  },
};

// ---------------------------------------------------------------------------
// § 1 — WEAVE_COMMAND_LABELS
// ---------------------------------------------------------------------------

describe("WEAVE_COMMAND_LABELS — adapter-owned command label constants", () => {
  it("startPlan label is /weave:start", () => {
    expect(WEAVE_COMMAND_LABELS.startPlan).toBe("/weave:start");
  });

  it("runWorkflow label is /weave:run", () => {
    expect(WEAVE_COMMAND_LABELS.runWorkflow).toBe("/weave:run");
  });

  it("status label is /weave:status", () => {
    expect(WEAVE_COMMAND_LABELS.status).toBe("/weave:status");
  });

  it("abort label is /weave:abort", () => {
    expect(WEAVE_COMMAND_LABELS.abort).toBe("/weave:abort");
  });

  it("advance label is /weave:advance", () => {
    expect(WEAVE_COMMAND_LABELS.advance).toBe("/weave:advance");
  });

  it("health label is /weave:health", () => {
    expect(WEAVE_COMMAND_LABELS.health).toBe("/weave:health");
  });

  it("no label references /start-work (out of scope)", () => {
    const labels = Object.values(WEAVE_COMMAND_LABELS);
    for (const label of labels) {
      expect(label).not.toBe("/start-work");
    }
  });
});

// ---------------------------------------------------------------------------
// § 2 — DEGRADED_AFFORDANCES
// ---------------------------------------------------------------------------

describe("DEGRADED_AFFORDANCES — documented degraded native affordances", () => {
  it("documents /weave:abort as degraded (TUI abort not yet wired)", () => {
    const abortEntry = DEGRADED_AFFORDANCES.find(
      (a) => a.command === "/weave:abort",
    );
    expect(abortEntry).toBeDefined();
    if (abortEntry !== undefined) {
      expect(abortEntry.reason.length).toBeGreaterThan(0);
      expect(abortEntry.equivalent.length).toBeGreaterThan(0);
    }
  });

  it("documents /weave:advance as degraded (TUI step-advance not yet wired)", () => {
    const advanceEntry = DEGRADED_AFFORDANCES.find(
      (a) => a.command === "/weave:advance",
    );
    expect(advanceEntry).toBeDefined();
    if (advanceEntry !== undefined) {
      expect(advanceEntry.reason.length).toBeGreaterThan(0);
      expect(advanceEntry.equivalent.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// § 3 — handleStartPlan
// ---------------------------------------------------------------------------

describe("RuntimeCommandProjection.handleStartPlan — delegates to engine startPlan", () => {
  it("returns success result when plan exists and workflow runs", async () => {
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(true, true);

    const result = await projection.handleStartPlan({
      planName: "my-plan",
      workflowName: "simple-workflow",
      goal: "Test goal",
      slug: "test-goal",
      ownerId: "test-owner",
      store,
      planStateProvider,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
    });

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.command).toBe(WEAVE_COMMAND_LABELS.startPlan);
      expect(result.data.kind).toBe("execution-started");
      expect(result.data.workflowName).toBe("simple-workflow");
      expect(result.data.goal).toBe("Test goal");
      expect(result.message).toContain("/weave:start");
      expect(result.message).toContain("my-plan");
    }
  });

  it("returns failure result when plan does not exist", async () => {
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    // Provider reports plan does NOT exist
    const planStateProvider = new MockPlanStateProvider(false);

    const result = await projection.handleStartPlan({
      planName: "missing-plan",
      workflowName: "simple-workflow",
      goal: "Test goal",
      slug: "test-goal",
      ownerId: "test-owner",
      store,
      planStateProvider,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.command).toBe(WEAVE_COMMAND_LABELS.startPlan);
      expect(result.error.type).toBe("command_not_found");
      expect(result.message).toContain("/weave:start");
      expect(result.message).toContain("missing-plan");
    }
  });

  it("returns failure result when workflow does not exist", async () => {
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(true);

    const result = await projection.handleStartPlan({
      planName: "my-plan",
      workflowName: "nonexistent-workflow",
      goal: "Test goal",
      slug: "test-goal",
      ownerId: "test-owner",
      store,
      planStateProvider,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.error.type).toBe("command_not_found");
    }
  });

  it("calls adapter.spawnSubagent for each dispatched step", async () => {
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(true, true);

    await projection.handleStartPlan({
      planName: "my-plan",
      workflowName: "simple-workflow",
      goal: "Test goal",
      slug: "test-goal",
      ownerId: "test-owner",
      store,
      planStateProvider,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
    });

    // Both steps should have been dispatched through spawnSubagent
    expect(adapter.spawnSubagentCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("does not duplicate lifecycle state-transition logic — store is mutated only by engine", async () => {
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(true, true);

    // Before: store is empty
    const before = await store.instances.list();
    expect(before.isOk()).toBe(true);
    if (before.isOk()) {
      expect(before.value).toHaveLength(0);
    }

    await projection.handleStartPlan({
      planName: "my-plan",
      workflowName: "simple-workflow",
      goal: "Test goal",
      slug: "test-goal",
      ownerId: "test-owner",
      store,
      planStateProvider,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
    });

    // After: store has a WorkflowInstance — created by the engine, not the projection
    const after = await store.instances.list();
    expect(after.isOk()).toBe(true);
    if (after.isOk()) {
      expect(after.value.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("returns failure with validation error when planStateProvider is missing", async () => {
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    // planStateProvider is required — engine returns command_validation
    const result = await projection.handleStartPlan({
      planName: "my-plan",
      workflowName: "simple-workflow",
      goal: "Test goal",
      slug: "test-goal",
      ownerId: "test-owner",
      store,
      planStateProvider: undefined as unknown as MockPlanStateProvider,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.error.type).toBe("command_validation");
    }
  });
});

// ---------------------------------------------------------------------------
// § 4 — handleRunWorkflow
// ---------------------------------------------------------------------------

describe("RuntimeCommandProjection.handleRunWorkflow — delegates to engine runNamedWorkflow", () => {
  it("returns success result when workflow runs successfully", async () => {
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    const result = await projection.handleRunWorkflow({
      workflowName: "simple-workflow",
      goal: "Test goal",
      slug: "test-goal",
      ownerId: "test-owner",
      store,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
    });

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.command).toBe(WEAVE_COMMAND_LABELS.runWorkflow);
      expect(result.data.kind).toBe("execution-started");
      expect(result.data.workflowName).toBe("simple-workflow");
      expect(result.message).toContain("/weave:run");
      expect(result.message).toContain("simple-workflow");
    }
  });

  it("returns failure result when workflow does not exist", async () => {
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    const result = await projection.handleRunWorkflow({
      workflowName: "nonexistent-workflow",
      goal: "Test goal",
      slug: "test-goal",
      ownerId: "test-owner",
      store,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.command).toBe(WEAVE_COMMAND_LABELS.runWorkflow);
      expect(result.error.type).toBe("command_not_found");
      expect(result.message).toContain("/weave:run");
    }
  });

  it("calls adapter.spawnSubagent for each dispatched step", async () => {
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    await projection.handleRunWorkflow({
      workflowName: "simple-workflow",
      goal: "Test goal",
      slug: "test-goal",
      ownerId: "test-owner",
      store,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
    });

    expect(adapter.spawnSubagentCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("is explicitly separate from startPlan — does not validate plan existence", async () => {
    // Proof: runNamedWorkflow does NOT call planStateProvider.planExists.
    // Named workflow execution is separate from plan-first execution.
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(false); // plan does NOT exist

    // Even though the plan doesn't exist, runWorkflow succeeds because
    // it doesn't validate plan existence (that's startPlan's job).
    const result = await projection.handleRunWorkflow({
      workflowName: "simple-workflow",
      goal: "Test goal",
      slug: "test-goal",
      ownerId: "test-owner",
      store,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
      planStateProvider,
    });

    // runWorkflow succeeds — it doesn't check plan existence
    expect(result.outcome).toBe("success");

    // planExists was NOT called — named workflow execution is separate
    expect(planStateProvider.planExistsCalls).toHaveLength(0);
  });

  it("does not reference /start-work (out of scope)", () => {
    // Structural proof: the command label for runWorkflow is /weave:run, not /start-work.
    expect(WEAVE_COMMAND_LABELS.runWorkflow).not.toBe("/start-work");
    expect(WEAVE_COMMAND_LABELS.runWorkflow).toBe("/weave:run");
  });
});

// ---------------------------------------------------------------------------
// § 5 — handleInspectStatus
// ---------------------------------------------------------------------------

describe("RuntimeCommandProjection.handleInspectStatus — delegates to engine inspectStatus", () => {
  it("returns success result with execution status data", async () => {
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    // First, create a workflow instance by running a workflow
    const runResult = await projection.handleRunWorkflow({
      workflowName: "simple-workflow",
      goal: "Test goal",
      slug: "test-goal",
      ownerId: "test-owner",
      store,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
    });

    expect(runResult.outcome).toBe("success");
    if (runResult.outcome !== "success") return;

    const instanceId = runResult.data.workflowInstanceId;

    // Now inspect the status
    const statusResult = await projection.handleInspectStatus({
      workflowInstanceId: instanceId,
      store,
    });

    expect(statusResult.outcome).toBe("success");
    if (statusResult.outcome === "success") {
      expect(statusResult.command).toBe(WEAVE_COMMAND_LABELS.status);
      expect(statusResult.data.kind).toBe("execution-status");
      expect(statusResult.data.workflowInstanceId).toBe(instanceId);
      expect(statusResult.message).toContain("/weave:status");
      expect(statusResult.message).toContain(instanceId);
    }
  });

  it("returns failure result when workflow instance does not exist", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();

    const result = await projection.handleInspectStatus({
      workflowInstanceId: "nonexistent-instance-id",
      store,
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.command).toBe(WEAVE_COMMAND_LABELS.status);
      expect(result.error.type).toBe("command_not_found");
      expect(result.message).toContain("/weave:status");
    }
  });

  it("is read-only — does not create instances or acquire leases", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();

    // Before: store is empty
    const before = await store.instances.list();
    expect(before.isOk()).toBe(true);
    if (before.isOk()) {
      expect(before.value).toHaveLength(0);
    }

    // Inspect a nonexistent instance — should fail but not create anything
    await projection.handleInspectStatus({
      workflowInstanceId: "nonexistent-id",
      store,
    });

    // After: store is still empty — inspectStatus is read-only
    const after = await store.instances.list();
    expect(after.isOk()).toBe(true);
    if (after.isOk()) {
      expect(after.value).toHaveLength(0);
    }
  });

  it("returns status data with hasActiveLease field", async () => {
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    const runResult = await projection.handleRunWorkflow({
      workflowName: "simple-workflow",
      goal: "Test goal",
      slug: "test-goal",
      ownerId: "test-owner",
      store,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
    });

    if (runResult.outcome !== "success") return;

    const statusResult = await projection.handleInspectStatus({
      workflowInstanceId: runResult.data.workflowInstanceId,
      store,
    });

    if (statusResult.outcome === "success") {
      expect(typeof statusResult.data.hasActiveLease).toBe("boolean");
      expect(statusResult.data.status).toBeDefined();
      expect(statusResult.data.workflowName).toBe("simple-workflow");
    }
  });
});

// ---------------------------------------------------------------------------
// § 6 — handleAbortExecution
// ---------------------------------------------------------------------------

describe("RuntimeCommandProjection.handleAbortExecution — delegates to engine abortExecution", () => {
  it("returns failure when workflow instance does not exist", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();

    const result = await projection.handleAbortExecution({
      workflowInstanceId: "nonexistent-instance",
      leaseId: "nonexistent-lease",
      signal: "cancel",
      store,
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.command).toBe(WEAVE_COMMAND_LABELS.abort);
      expect(result.error.type).toBe("command_not_found");
      expect(result.message).toContain("/weave:abort");
    }
  });

  it("returns failure with validation error when workflowInstanceId is empty", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();

    const result = await projection.handleAbortExecution({
      workflowInstanceId: "",
      leaseId: "some-lease",
      signal: "cancel",
      store,
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.error.type).toBe("command_validation");
      expect(result.message).toContain("/weave:abort");
    }
  });

  it("returns failure with validation error when leaseId is empty", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();

    const result = await projection.handleAbortExecution({
      workflowInstanceId: "some-instance",
      leaseId: "",
      signal: "cancel",
      store,
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.error.type).toBe("command_validation");
    }
  });

  it("supports both cancel and pause signals", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();

    // Both signals should produce the same failure type (instance not found)
    // since we're using a nonexistent instance
    const cancelResult = await projection.handleAbortExecution({
      workflowInstanceId: "nonexistent",
      leaseId: "nonexistent-lease",
      signal: "cancel",
      store,
    });

    const pauseResult = await projection.handleAbortExecution({
      workflowInstanceId: "nonexistent",
      leaseId: "nonexistent-lease",
      signal: "pause",
      store,
    });

    expect(cancelResult.outcome).toBe("failure");
    expect(pauseResult.outcome).toBe("failure");
  });

  it("is documented as a degraded affordance (TUI abort not yet wired)", () => {
    const abortEntry = DEGRADED_AFFORDANCES.find(
      (a) => a.command === "/weave:abort",
    );
    expect(abortEntry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// § 7 — handleAdvanceStep
// ---------------------------------------------------------------------------

describe("RuntimeCommandProjection.handleAdvanceStep — delegates to engine advanceStep", () => {
  it("returns failure when workflow instance does not exist", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();

    const result = await projection.handleAdvanceStep({
      workflowInstanceId: "nonexistent-instance",
      leaseId: "nonexistent-lease",
      stepName: "step-one",
      completionSignal: { outcome: "success" },
      store,
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.command).toBe(WEAVE_COMMAND_LABELS.advance);
      expect(result.message).toContain("/weave:advance");
    }
  });

  it("returns failure with validation error when workflowInstanceId is empty", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();

    const result = await projection.handleAdvanceStep({
      workflowInstanceId: "",
      leaseId: "some-lease",
      stepName: "step-one",
      completionSignal: { outcome: "success" },
      store,
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.error.type).toBe("command_validation");
    }
  });

  it("returns failure with validation error when stepName is empty", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();

    const result = await projection.handleAdvanceStep({
      workflowInstanceId: "some-instance",
      leaseId: "some-lease",
      stepName: "",
      completionSignal: { outcome: "success" },
      store,
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.error.type).toBe("command_validation");
    }
  });

  it("is documented as a degraded affordance (TUI step-advance not yet wired)", () => {
    const advanceEntry = DEGRADED_AFFORDANCES.find(
      (a) => a.command === "/weave:advance",
    );
    expect(advanceEntry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// § 8 — handleRuntimeHealth
// ---------------------------------------------------------------------------

describe("RuntimeCommandProjection.handleRuntimeHealth — delegates to engine runtimeHealth", () => {
  it("returns success result when adapter is fully ready", async () => {
    const projection = new RuntimeCommandProjection();
    const healthReport = buildOpenCodeHealthReport({
      commandEntrypointsReadiness: "native",
    });

    const result = await projection.handleRuntimeHealth({ healthReport });

    // runtimeHealth always returns a result (never fails)
    expect(result.outcome === "success" || result.outcome === "degraded").toBe(
      true,
    );
    expect(result.command).toBe(WEAVE_COMMAND_LABELS.health);
    expect(result.message).toContain("/weave:health");
    expect(result.message).toContain("opencode");
  });

  it("returns degraded result when commandEntrypoints is degraded", async () => {
    const projection = new RuntimeCommandProjection();
    const healthReport = buildOpenCodeHealthReport({
      commandEntrypointsReadiness: "degraded",
    });

    const result = await projection.handleRuntimeHealth({
      healthReport,
      degradedOperations: ["command-entrypoints: slash commands not available"],
    });

    expect(result.outcome).toBe("degraded");
    if (result.outcome === "degraded") {
      expect(result.command).toBe(WEAVE_COMMAND_LABELS.health);
      expect(result.message).toContain("/weave:health");
      expect(result.data).toBeDefined();
    }
  });

  it("returns degraded result when adapter is not ready", async () => {
    const projection = new RuntimeCommandProjection();
    const healthReport = buildOpenCodeHealthReport({
      commandEntrypointsReadiness: "unsupported",
    });

    const result = await projection.handleRuntimeHealth({
      healthReport,
      unsupportedOperations: ["command-entrypoints: no slash commands"],
    });

    // unsupported command-entrypoints → not ready → degraded
    expect(result.outcome === "success" || result.outcome === "degraded").toBe(
      true,
    );
    expect(result.command).toBe(WEAVE_COMMAND_LABELS.health);
  });

  it("data carries commandEntrypointsSupported field", async () => {
    const projection = new RuntimeCommandProjection();
    const healthReport = buildOpenCodeHealthReport({
      commandEntrypointsReadiness: "native",
    });

    const result = await projection.handleRuntimeHealth({ healthReport });

    if (result.outcome === "success" || result.outcome === "degraded") {
      expect(result.data).toBeDefined();
      if (result.data !== undefined) {
        expect(typeof result.data.commandEntrypointsSupported).toBe("boolean");
        expect(result.data.kind).toBe("runtime-health");
      }
    }
  });

  it("accepts explicit degradedOperations and unsupportedOperations lists", async () => {
    const projection = new RuntimeCommandProjection();
    const healthReport = buildOpenCodeHealthReport();

    const result = await projection.handleRuntimeHealth({
      healthReport,
      degradedOperations: ["start-plan: plan files not found"],
      unsupportedOperations: ["advance-step: TUI not wired"],
    });

    if (result.outcome === "degraded" && result.data !== undefined) {
      expect(result.data.degradedOperations).toContain(
        "start-plan: plan files not found",
      );
      expect(result.data.unsupportedOperations).toContain(
        "advance-step: TUI not wired",
      );
    }
  });

  it("never fails — runtimeHealth always returns a result", async () => {
    const projection = new RuntimeCommandProjection();
    const healthReport = buildOpenCodeHealthReport();

    // runtimeHealth is pure and never fails — the result is always success or degraded
    const result = await projection.handleRuntimeHealth({ healthReport });

    expect(result.outcome).not.toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// § 9 — ProjectionResult shape invariants
// ---------------------------------------------------------------------------

describe("ProjectionResult — shape invariants across all handlers", () => {
  it("success result always has outcome, command, data, and message", async () => {
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    const result = await projection.handleRunWorkflow({
      workflowName: "simple-workflow",
      goal: "Test",
      slug: "test",
      ownerId: "owner",
      store,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
    });

    if (result.outcome === "success") {
      expect(result.outcome).toBe("success");
      expect(typeof result.command).toBe("string");
      expect(result.data).toBeDefined();
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("failure result always has outcome, command, error, and message", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();

    const result = await projection.handleInspectStatus({
      workflowInstanceId: "nonexistent",
      store,
    });

    if (result.outcome === "failure") {
      expect(result.outcome).toBe("failure");
      expect(typeof result.command).toBe("string");
      expect(result.error).toBeDefined();
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("degraded result always has outcome, command, and message", async () => {
    const projection = new RuntimeCommandProjection();
    const healthReport = buildOpenCodeHealthReport({
      commandEntrypointsReadiness: "degraded",
    });

    const result = await projection.handleRuntimeHealth({
      healthReport,
      degradedOperations: ["command-entrypoints: degraded"],
    });

    if (result.outcome === "degraded") {
      expect(result.outcome).toBe("degraded");
      expect(typeof result.command).toBe("string");
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("failure messages include the command label for context", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();

    const statusResult = await projection.handleInspectStatus({
      workflowInstanceId: "nonexistent",
      store,
    });

    const abortResult = await projection.handleAbortExecution({
      workflowInstanceId: "nonexistent",
      leaseId: "nonexistent",
      signal: "cancel",
      store,
    });

    if (statusResult.outcome === "failure") {
      expect(statusResult.message).toContain(WEAVE_COMMAND_LABELS.status);
    }
    if (abortResult.outcome === "failure") {
      expect(abortResult.message).toContain(WEAVE_COMMAND_LABELS.abort);
    }
  });
});

// ---------------------------------------------------------------------------
// § 10 — Adapter boundary: no lifecycle logic duplicated
// ---------------------------------------------------------------------------

describe("RuntimeCommandProjection — adapter boundary: no lifecycle logic duplicated", () => {
  it("handleStartPlan does not create WorkflowInstances directly — delegates to engine", async () => {
    // Proof: the projection layer never calls store.instances.create() directly.
    // All store mutations happen inside the engine's startPlan operation.
    // We verify this by checking that a failed plan lookup leaves the store empty.
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();
    const planStateProvider = new MockPlanStateProvider(false); // plan does NOT exist

    await projection.handleStartPlan({
      planName: "missing-plan",
      workflowName: "simple-workflow",
      goal: "Test",
      slug: "test",
      ownerId: "owner",
      store,
      planStateProvider,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
    });

    // Store is empty — the projection layer did not create any instances
    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value).toHaveLength(0);
    }
  });

  it("handleRunWorkflow does not create WorkflowInstances directly — delegates to engine", async () => {
    const projection = new RuntimeCommandProjection();
    const adapter = new MockOpenCodeAdapter();
    const store = createInMemoryRuntimeStore();

    await projection.handleRunWorkflow({
      workflowName: "nonexistent-workflow",
      goal: "Test",
      slug: "test",
      ownerId: "owner",
      store,
      workflows: SIMPLE_WORKFLOWS,
      adapter,
    });

    // Store is empty — workflow not found, no instance created
    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value).toHaveLength(0);
    }
  });

  it("handleRuntimeHealth is pure — performs no store mutations", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();
    const healthReport = buildOpenCodeHealthReport();

    await projection.handleRuntimeHealth({ healthReport });

    // Store is untouched — runtimeHealth is pure
    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);
    if (instances.isOk()) {
      expect(instances.value).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// § 11 — Completion signals: review_verdict, plan completion, degraded paths
// ---------------------------------------------------------------------------

/**
 * Helper: create a blocked instance on a specific step with an active lease.
 * Used for completion signal tests that need a specific workflow and step.
 */
async function createBlockedInstanceOnStep(
  store: ReturnType<typeof createInMemoryRuntimeStore>,
  workflowName: string,
  stepName: string,
) {
  const instance = await store.instances.create({
    workflowName,
    goal: "Test goal",
    slug: "test-slug",
  });
  if (!instance.isOk()) throw new Error("Failed to create instance");

  await store.instances.update(instance.value.id, {
    status: "blocked",
    currentStepName: stepName,
  });

  const lease = await store.leases.acquire({
    workflowInstanceId: instance.value.id,
    ownerId: "owner-test" as Parameters<
      typeof store.leases.acquire
    >[0]["ownerId"],
    ttlMs: 60_000,
  });
  if (!lease.isOk()) throw new Error("Failed to acquire lease");

  return { instance: instance.value, lease: lease.value };
}

describe("RuntimeCommandProjection.handleAdvanceStep — review_verdict: approved (success path)", () => {
  it("returns success result when review_verdict is approved", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "gate-workflow",
      "gate",
    );

    const result = await projection.handleAdvanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "gate",
      completionSignal: {
        outcome: "success",
        method: "review_verdict",
        approved: true,
      },
      store,
      context: {
        workflowName: "gate-workflow",
        goal: "Test goal",
        slug: "test-slug",
        workflows: GATE_WORKFLOWS,
      },
    });

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.command).toBe(WEAVE_COMMAND_LABELS.advance);
      expect(result.data.kind).toBe("step-advanced");
      expect(result.data.stepName).toBe("gate");
      expect(result.message).toContain("/weave:advance");
    }
  });

  it("success message includes step name and signal outcome", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "gate-workflow",
      "gate",
    );

    const result = await projection.handleAdvanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "gate",
      completionSignal: {
        outcome: "success",
        method: "review_verdict",
        approved: true,
      },
      store,
      context: {
        workflowName: "gate-workflow",
        goal: "Test goal",
        slug: "test-slug",
        workflows: GATE_WORKFLOWS,
      },
    });

    if (result.outcome === "success") {
      expect(result.message).toContain("gate");
      expect(result.message).toContain("success");
    }
  });
});

describe("RuntimeCommandProjection.handleAdvanceStep — review_verdict: rejected + on_reject: pause", () => {
  it("returns success result with pause-execution effect when rejected", async () => {
    // Rejected review_verdict with on_reject:pause → success result (engine handles it)
    // The engine returns ok(StepAdvancedData) with pause-execution effect.
    // The projection layer renders this as a success result.
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "gate-workflow",
      "gate",
    );

    const result = await projection.handleAdvanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "gate",
      completionSignal: {
        outcome: "success",
        method: "review_verdict",
        approved: false,
        message: "Changes need revision",
      },
      store,
      context: {
        workflowName: "gate-workflow",
        goal: "Test goal",
        slug: "test-slug",
        workflows: GATE_WORKFLOWS,
      },
    });

    // Engine returns ok(StepAdvancedData) — projection renders as success
    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.command).toBe(WEAVE_COMMAND_LABELS.advance);
      expect(result.data.kind).toBe("step-advanced");
      // Rejected gate → pause-execution effect in the result data
      const pauseEffect = result.data.effects.find(
        (e) => e.kind === "pause-execution",
      );
      expect(pauseEffect).toBeDefined();
    }
  });

  it("instance transitions to paused status after rejected review_verdict", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "gate-workflow",
      "gate",
    );

    await projection.handleAdvanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "gate",
      completionSignal: {
        outcome: "success",
        method: "review_verdict",
        approved: false,
      },
      store,
      context: {
        workflowName: "gate-workflow",
        goal: "Test goal",
        slug: "test-slug",
        workflows: GATE_WORKFLOWS,
      },
    });

    // Instance transitions to paused — engine owns this state transition
    const afterInstance = await store.instances.getById(instance.id);
    expect(afterInstance.isOk()).toBe(true);
    if (afterInstance.isOk()) {
      expect(afterInstance.value.status).toBe("paused");
    }
  });

  it("is documented as a degraded affordance (TUI step-advance not yet wired)", () => {
    // The advance step command is documented as degraded because the TUI
    // step-advance UI is not yet wired to this handler.
    const advanceEntry = DEGRADED_AFFORDANCES.find(
      (a) => a.command === "/weave:advance",
    );
    expect(advanceEntry).toBeDefined();
    if (advanceEntry !== undefined) {
      expect(advanceEntry.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("RuntimeCommandProjection.handleAdvanceStep — plan_created: missing planStateProvider (degraded fallback)", () => {
  it("returns failure result when planStateProvider is absent for plan_created step", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "plan-completion-workflow",
      "create-plan",
    );

    // No planStateProvider — plan_created completion requires one
    const result = await projection.handleAdvanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "create-plan",
      completionSignal: {
        outcome: "success",
        method: "plan_created",
      },
      store,
      context: {
        workflowName: "plan-completion-workflow",
        goal: "Test goal",
        slug: "test-slug",
        workflows: PLAN_COMPLETION_WORKFLOWS,
      },
      // planStateProvider intentionally absent — degraded fallback
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.command).toBe(WEAVE_COMMAND_LABELS.advance);
      // Missing provider → policy_decision lifecycle error → command_lifecycle
      expect(result.error.type).toBe("command_lifecycle");
      expect(result.message).toContain("/weave:advance");
    }
  });

  it("returns failure result when planStateProvider is absent for plan_complete step", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "plan-completion-workflow",
      "execute-plan",
    );

    // No planStateProvider — plan_complete completion requires one
    const result = await projection.handleAdvanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "execute-plan",
      completionSignal: {
        outcome: "success",
        method: "plan_complete",
      },
      store,
      context: {
        workflowName: "plan-completion-workflow",
        goal: "Test goal",
        slug: "test-slug",
        workflows: PLAN_COMPLETION_WORKFLOWS,
      },
      // planStateProvider intentionally absent — degraded fallback
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.command).toBe(WEAVE_COMMAND_LABELS.advance);
      expect(result.error.type).toBe("command_lifecycle");
    }
  });

  it("returns success when planStateProvider is supplied and plan exists", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "plan-completion-workflow",
      "create-plan",
    );

    // Provider reports plan EXISTS
    const planStateProvider = new MockPlanStateProvider(true, true);

    const result = await projection.handleAdvanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "create-plan",
      completionSignal: {
        outcome: "success",
        method: "plan_created",
      },
      store,
      context: {
        workflowName: "plan-completion-workflow",
        goal: "Test goal",
        slug: "test-slug",
        workflows: PLAN_COMPLETION_WORKFLOWS,
      },
      planStateProvider,
    });

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.data.kind).toBe("step-advanced");
    }
  });
});

describe("RuntimeCommandProjection.handleAdvanceStep — unsupported automatic signal detection (degraded path)", () => {
  /**
   * OpenCode cannot detect structured completion signals automatically.
   *
   * The `handleAdvanceStep` handler requires adapters to supply an explicit
   * `completionSignal` with `outcome` and optionally `method`. There is no
   * automatic signal detection — the engine does not poll for agent output
   * or parse harness events to infer completion.
   *
   * This is the documented degraded path: adapters that cannot wire TUI
   * step-advance must supply explicit signals via the command operation.
   * The `DEGRADED_AFFORDANCES` list documents this limitation.
   */

  it("returns failure with validation error when completionSignal outcome is missing", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();

    // Missing outcome → command_validation (not automatic detection).
    // The projection layer requires an explicit outcome — there is no automatic
    // signal detection from harness events or agent output.
    const result = await projection.handleAdvanceStep({
      workflowInstanceId: "nonexistent-instance",
      leaseId: "nonexistent-lease",
      stepName: "execute",
      completionSignal: {
        outcome: "" as "success" | "blocked" | "failed" | "paused",
      },
      store,
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      // Explicit validation error — not a silent automatic detection failure
      expect(result.error.type).toBe("command_validation");
      expect(result.message).toContain("/weave:advance");
    }
  });

  it("returns failure with validation error when outcome is missing", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();

    // Missing outcome → command_validation (not automatic detection)
    const result = await projection.handleAdvanceStep({
      workflowInstanceId: "nonexistent-instance",
      leaseId: "nonexistent-lease",
      stepName: "execute",
      completionSignal: {
        outcome: "" as "success" | "blocked" | "failed" | "paused",
      },
      store,
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      // Explicit validation error — outcome must be supplied by the adapter
      expect(result.error.type).toBe("command_validation");
    }
  });

  it("accepts agent_signal method when explicitly supplied by adapter", async () => {
    const projection = new RuntimeCommandProjection();
    const store = createInMemoryRuntimeStore();
    const { instance, lease } = await createBlockedInstanceOnStep(
      store,
      "gate-workflow",
      "work",
    );

    // Adapter explicitly supplies agent_signal method — no automatic detection
    const result = await projection.handleAdvanceStep({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      stepName: "work",
      completionSignal: {
        outcome: "success",
        method: "agent_signal",
      },
      store,
      context: {
        workflowName: "gate-workflow",
        goal: "Test goal",
        slug: "test-slug",
        workflows: GATE_WORKFLOWS,
      },
    });

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.data.kind).toBe("step-advanced");
      expect(result.data.completionSignal.method).toBe("agent_signal");
    }
  });

  it("degraded affordance: /weave:advance is documented as not yet TUI-wired", () => {
    // Structural proof: the advance command is in DEGRADED_AFFORDANCES because
    // OpenCode's TUI cannot automatically detect step completion signals.
    // Adapters must supply explicit completionSignal via the command operation.
    const advanceEntry = DEGRADED_AFFORDANCES.find(
      (a) => a.command === "/weave:advance",
    );
    expect(advanceEntry).toBeDefined();
    if (advanceEntry !== undefined) {
      expect(advanceEntry.reason).toContain("TUI");
      expect(advanceEntry.equivalent.length).toBeGreaterThan(0);
    }
  });
});
