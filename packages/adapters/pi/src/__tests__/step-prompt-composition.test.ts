/**
 * Regression tests for the direct-dispatch step-prompt composition fix
 * (Weave issue #21 Task 12).
 *
 * Root cause: `dispatchStep`/`completeStep` render `step.prompt` but only
 * ever placed its byte length inside `RunAgentEffect.promptMetadata` — the
 * rendered text itself never left the engine. `runDispatchAgentEffect`
 * built the direct-dispatch `composedPrompt` from only the activated
 * agent's own `AgentDescriptor.composedPrompt`, so the direct-step child
 * never saw `step.prompt` content at all.
 *
 * Fix: the engine now threads the rendered text out-of-band via the
 * ephemeral `stepPromptText` field on `DispatchStepOutput`/
 * `CompleteStepOutput`. `PiWorkflowController.runDispatchAgentEffect`
 * receives it as an extra parameter and sends it as the direct child's
 * bounded task prompt while the descriptor's `composedPrompt` remains the
 * child's system prompt. Keeping those channels separate prevents a full
 * canonical primary prompt (such as Tapestry's) from overflowing the
 * ordinary delegation-task bound.
 *
 * These tests prove, against a fully scripted `FakeDirectDispatchPort` (no
 * real Pi process, no network — Pi adapter contract), that the exact rendered
 * `step.prompt` text reaches the task prompt sent to the child, both
 * on the very first dispatch (driven by `dispatchStep` via
 * `runDispatchLoop`) and on the auto-advanced second step (driven by
 * `completeStep`'s own returned `dispatch-agent` effect).
 */

import { describe, expect, it } from "bun:test";
import { parseConfig } from "@weaveio/weave-core";
import {
  createInMemoryRuntimeStore,
  type RuntimeStore,
  type WorkflowExecutionContext,
} from "@weaveio/weave-engine";
import { ok, okAsync } from "neverthrow";
import { FakePiArtifactProvider } from "../artifact-provider.js";
import {
  FakeDirectDispatchPort,
  type PiDirectDispatchCandidate,
} from "../direct-dispatch.js";
import { InMemoryRecoveryPointerStore } from "../recovery-pointer.js";
import {
  authorizeByExplicitUser,
  PiWorkflowController,
  type PiWorkflowControllerDeps,
} from "../workflow-controller.js";
import { FakePlanStateProvider } from "./fakes/fake-plan-state-provider.js";

function cfg(source: string) {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const TWO_STEP_WORKFLOW = cfg(`
workflow simple-flow {
  description "Simple two-step workflow"
  version 1

  step plan {
    name "Create plan"
    type autonomous
    agent pattern
    prompt "Create a plan for: {{instance.goal}}"
    completion agent_signal
  }

  step implement {
    name "Implement"
    type autonomous
    agent shuttle
    prompt "Implement the plan for: {{instance.goal}}"
    completion agent_signal
  }
}
`);

function buildContext(): WorkflowExecutionContext {
  const workflow = TWO_STEP_WORKFLOW.workflows["simple-flow"];
  if (workflow === undefined) throw new Error("fixture missing simple-flow");
  return {
    workflowName: "simple-flow",
    goal: "test goal",
    slug: "test-goal",
    workflows: { "simple-flow": workflow },
  };
}

function successCandidate(): PiDirectDispatchCandidate {
  return { outcome: "success", method: "agent_signal" };
}

interface Harness {
  store: RuntimeStore;
  directDispatch: FakeDirectDispatchPort;
  controller: PiWorkflowController;
  activeChanges: Array<{ active: boolean; agentName: string }>;
}

function buildHarness(): Harness {
  const store = createInMemoryRuntimeStore();
  const directDispatch = new FakeDirectDispatchPort();
  const activeChanges: Array<{ active: boolean; agentName: string }> = [];
  const deps: PiWorkflowControllerDeps = {
    store,
    planStateProvider: new FakePlanStateProvider(),
    artifactProvider: new FakePiArtifactProvider(new Map()),
    directDispatch,
    recoveryPointerStore: new InMemoryRecoveryPointerStore(),
    clock: { now: () => 1_700_000_000_000 },
    idGenerator: { next: () => "generated-id" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    controllerGenerationId: "gen-1",
    assertGenerationCurrent: () => ok(undefined),
    ownerId: "test-owner",
    projectRoot: "/tmp/fake-project",
    maxAutoAdvanceSteps: 10,
    onDirectStepActiveChange: (active, agentName) => {
      activeChanges.push({ active, agentName });
    },
    // The activated descriptor's own composedPrompt is deliberately
    // distinct from the step.prompt text so a test assertion that finds
    // both substrings in the right order can only pass if the fix
    // actually threads stepPromptText through — never by coincidence.
    resolveAgentDescriptor: (agentName) => ({
      name: agentName,
      composedPrompt: `AGENT-BASE-PROMPT-FOR-${agentName}`,
      models: [],
      mode: "subagent",
      effectiveToolPolicy: {
        read: "allow",
        write: "allow",
        execute: "allow",
        delegate: "deny",
        network: "deny",
      },
      rawToolPolicy: undefined,
      delegationTargets: [],
      skills: [],
    }),
  };
  return {
    store,
    directDispatch,
    controller: new PiWorkflowController(deps),
    activeChanges,
  };
}

async function createInstance(store: RuntimeStore): Promise<string> {
  const result = await store.instances.create({
    workflowName: "simple-flow",
    goal: "test goal",
    slug: "test-goal",
  });
  if (!result.isOk())
    throw new Error(`failed to create instance: ${result.error.message}`);
  return result.value.id as unknown as string;
}

describe("PiWorkflowController — direct-dispatch step-prompt composition (Task 12)", () => {
  it("keeps the first step task separate from the agent's own composedPrompt", async () => {
    const { store, directDispatch, controller } = buildHarness();
    const workflowInstanceId = await createInstance(store);
    directDispatch.enqueue(okAsync(successCandidate()) as never);
    directDispatch.enqueue(okAsync(successCandidate()) as never);

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected auth failure");

    await controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );

    const firstCall = directDispatch.calls[0];
    expect(firstCall?.stepName).toBe("plan");
    expect(firstCall?.composedPrompt).toBe("AGENT-BASE-PROMPT-FOR-pattern");
    expect(firstCall?.taskPrompt).toBe("Create a plan for: test goal");
    expect(firstCall?.composedPrompt).not.toContain(
      "Create a plan for: test goal",
    );
  });

  it("keeps the auto-advanced second step task separate and reports normalized active-agent names", async () => {
    const { store, directDispatch, controller, activeChanges } = buildHarness();
    const workflowInstanceId = await createInstance(store);
    directDispatch.enqueue(okAsync(successCandidate()) as never);
    directDispatch.enqueue(okAsync(successCandidate()) as never);

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected auth failure");

    const result = await controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );

    expect(result.isOk()).toBe(true);
    expect(directDispatch.calls.map((c) => c.stepName)).toEqual([
      "plan",
      "implement",
    ]);

    const secondCall = directDispatch.calls[1];
    expect(secondCall?.composedPrompt).toBe("AGENT-BASE-PROMPT-FOR-shuttle");
    expect(secondCall?.taskPrompt).toBe("Implement the plan for: test goal");
    expect(activeChanges).toEqual([
      { active: true, agentName: "pattern" },
      { active: false, agentName: "pattern" },
      { active: true, agentName: "shuttle" },
      { active: false, agentName: "shuttle" },
    ]);
  });
});
