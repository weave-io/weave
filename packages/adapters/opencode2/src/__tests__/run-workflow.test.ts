import { describe, expect, it } from "bun:test";

import type { WorkflowConfig } from "@weaveio/weave-core";
import { createInMemoryRuntimeStore } from "@weaveio/weave-engine";
import { buildProjectEffect, runWorkflow } from "../run-workflow.js";
import { MockPluginContext } from "./mock-plugin-context.js";

const SIMPLE_WORKFLOWS: Record<string, WorkflowConfig> = {
  "simple-execution": {
    description: "Simple execution workflow for testing",
    version: 1,
    steps: [
      {
        name: "execute",
        display_name: "Execute",
        type: "autonomous" as const,
        agent: "shuttle",
        prompt: "Execute for: {{instance.goal}}",
        completion: { method: "agent_signal" as const },
      },
    ],
  },
};

const MULTI_STEP_WORKFLOWS: Record<string, WorkflowConfig> = {
  "multi-step-execution": {
    description: "Multi-step execution workflow for testing",
    version: 1,
    steps: [
      {
        name: "plan",
        display_name: "Plan",
        type: "autonomous" as const,
        agent: "loom",
        prompt: "Plan for: {{instance.goal}}",
        completion: { method: "agent_signal" as const },
      },
      {
        name: "execute",
        display_name: "Execute",
        type: "autonomous" as const,
        agent: "shuttle",
        prompt: "Execute for: {{instance.goal}}",
        completion: { method: "agent_signal" as const },
      },
    ],
  },
};

/** Helper: queue a settlement event for a session on a MockPluginContext. */
function queueSettlement(facade: MockPluginContext, sessionID: string): void {
  facade.queueEvent({
    id: "evt-1",
    created: Date.now(),
    type: "session.idle",
    data: { sessionID },
  } as never);
}

describe("buildProjectEffect", () => {
  it("delivers the delegated prompt then waits for settlement and drain", async () => {
    const facade = new MockPluginContext();
    const controller = new AbortController();
    queueSettlement(facade, "session-1");

    const projectEffect = buildProjectEffect(
      facade,
      "session-1",
      controller.signal,
    );

    const effect = {
      kind: "dispatch-agent" as const,
      runAgent: {
        kind: "run-agent" as const,
        agentName: "shuttle",
        agentDescriptor: {
          name: "shuttle",
          composedPrompt: "Do the thing.",
          models: [],
          mode: "subagent" as const,
          effectiveToolPolicy: {
            read: "allow" as const,
            write: "allow" as const,
            execute: "allow" as const,
            delegate: "deny" as const,
            network: "ask" as const,
          },
          rawToolPolicy: undefined,
          delegationTargets: [],
          skills: [],
        },
      },
    };

    const result = await projectEffect(effect as never);

    expect(result.isOk()).toBe(true);
    const methods = facade.calls.map((c) => c.method);
    expect(methods).toContain("session.prompt");
    expect(methods).toContain("event.subscribe");
    expect(methods).toContain("session.wait");
  });

  it("returns a clean (non-throwing) error when the abort signal fires before settlement", async () => {
    const facade = new MockPluginContext();
    const controller = new AbortController();
    controller.abort();
    // No settlement event queued — subscription should observe the abort.

    const projectEffect = buildProjectEffect(
      facade,
      "session-1",
      controller.signal,
    );

    const effect = {
      kind: "dispatch-agent" as const,
      runAgent: {
        kind: "run-agent" as const,
        agentName: "shuttle",
        agentDescriptor: {
          name: "shuttle",
          composedPrompt: "Do the thing.",
          models: [],
          mode: "subagent" as const,
          effectiveToolPolicy: {
            read: "allow" as const,
            write: "allow" as const,
            execute: "allow" as const,
            delegate: "deny" as const,
            network: "ask" as const,
          },
          rawToolPolicy: undefined,
          delegationTargets: [],
          skills: [],
        },
      },
    };

    const result = await projectEffect(effect as never);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("projection_error");
    }
    // session.wait must NOT have been called after an abort.
    const methods = facade.calls.map((c) => c.method);
    expect(methods).not.toContain("session.wait");
  });
});

describe("runWorkflow", () => {
  it("drives a single-step workflow to completion via the engine lifecycle", async () => {
    const facade = new MockPluginContext();
    queueSettlement(facade, "session-1");
    const store = createInMemoryRuntimeStore();

    const result = await runWorkflow(facade, {
      workflowName: "simple-execution",
      goal: "Run the workflow",
      slug: "run-the-workflow",
      ownerId: "run-workflow-test",
      store,
      workflows: SIMPLE_WORKFLOWS,
      sessionID: "session-1",
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe("completed");
      expect(result.value.stepsDispatched).toBe(1);
    }

    const methods = facade.calls.map((c) => c.method);
    expect(methods).toContain("session.prompt");
    expect(methods).toContain("event.subscribe");
  });

  it("drives a multi-step workflow, dispatching one prompt per step", async () => {
    const facade = new MockPluginContext();
    // Two steps → two settlement events (queued in dispatch order).
    queueSettlement(facade, "session-1");
    queueSettlement(facade, "session-1");
    const store = createInMemoryRuntimeStore();

    const result = await runWorkflow(facade, {
      workflowName: "multi-step-execution",
      goal: "Run the multi-step workflow",
      slug: "run-the-multi-step-workflow",
      ownerId: "run-workflow-test",
      store,
      workflows: MULTI_STEP_WORKFLOWS,
      sessionID: "session-1",
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe("completed");
      expect(result.value.stepsDispatched).toBe(2);
    }

    const promptCalls = facade.calls.filter(
      (c) => c.method === "session.prompt",
    );
    expect(promptCalls).toHaveLength(2);
  });

  it("disposes captured registrations on completion", async () => {
    const facade = new MockPluginContext();
    queueSettlement(facade, "session-1");
    const store = createInMemoryRuntimeStore();

    let disposed = false;
    const registration = {
      dispose: async () => {
        disposed = true;
      },
    };

    const result = await runWorkflow(facade, {
      workflowName: "simple-execution",
      goal: "Run the workflow",
      slug: "run-the-workflow",
      ownerId: "run-workflow-test",
      store,
      workflows: SIMPLE_WORKFLOWS,
      sessionID: "session-1",
      registrations: [registration],
    });

    expect(result.isOk()).toBe(true);
    expect(disposed).toBe(true);
  });

  it("aborts cleanly when the external abort signal fires before settlement", async () => {
    const facade = new MockPluginContext();
    // No settlement event queued.
    const store = createInMemoryRuntimeStore();
    const controller = new AbortController();
    controller.abort();

    const result = await runWorkflow(
      facade,
      {
        workflowName: "simple-execution",
        goal: "Run the workflow",
        slug: "run-the-workflow",
        ownerId: "run-workflow-test",
        store,
        workflows: SIMPLE_WORKFLOWS,
        sessionID: "session-1",
      },
      controller.signal,
    );

    expect(result.isErr()).toBe(true);
  });

  it("returns an error for an unknown workflow name without touching session.prompt", async () => {
    const facade = new MockPluginContext();
    const store = createInMemoryRuntimeStore();

    const result = await runWorkflow(facade, {
      workflowName: "does-not-exist",
      goal: "Run the workflow",
      slug: "run-the-workflow",
      ownerId: "run-workflow-test",
      store,
      workflows: SIMPLE_WORKFLOWS,
      sessionID: "session-1",
    });

    expect(result.isErr()).toBe(true);
    const methods = facade.calls.map((c) => c.method);
    expect(methods).not.toContain("session.prompt");
  });
});
