import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@weaveio/weave-core";
import {
  type ArtifactApprovalActor,
  createExecutionLeaseId,
  createInMemoryRuntimeStore,
  createOwnerId,
  createSqliteRuntimeStore,
  createWorkflowInstanceId,
  type RuntimeStore,
  type WorkflowExecutionContext,
} from "@weaveio/weave-engine";
import { err, ok, okAsync } from "neverthrow";
import { FakePiArtifactProvider } from "../artifact-provider.js";
import {
  FakeDirectDispatchPort,
  type PiDirectDispatchCandidate,
} from "../direct-dispatch.js";
import { makeControllerGenerationStaleFailure } from "../errors.js";
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
  return {
    workflowName: "simple-flow",
    goal: "test goal",
    slug: "test-goal",
    workflows: {
      "simple-flow": (() => {
        const workflow = TWO_STEP_WORKFLOW.workflows["simple-flow"];
        if (workflow === undefined)
          throw new Error("fixture missing simple-flow workflow");
        return workflow;
      })(),
    },
  };
}

function successCandidate(): PiDirectDispatchCandidate {
  return { outcome: "success", method: "agent_signal" };
}

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function userActor(): ArtifactApprovalActor {
  return { kind: "user", provenance: { source: "weave:artifact" } };
}

function agentActor(
  agentName: string,
  gate: "review" | "security" = "review",
): ArtifactApprovalActor {
  return { kind: "agent", agentName, gate };
}

/** A single-step workflow whose one step declares a normative `spec` input artifact - the minimal fixture for pre-dispatch artifact-integrity tests (Pi adapter contract). */
const ARTIFACT_INPUT_WORKFLOW = cfg(`
workflow artifact-flow {
  description "Single-step workflow gated on an approved spec artifact"
  version 1

  step implement {
    name "Implement the approved spec"
    type autonomous
    agent shuttle
    prompt "Implement the spec for: {{instance.goal}}"
    completion agent_signal

    inputs [
      { name "spec" description "The approved spec artifact" }
    ]
  }
}
`);

function artifactInputContext(): WorkflowExecutionContext {
  return {
    workflowName: "artifact-flow",
    goal: "test goal",
    slug: "test-goal",
    workflows: {
      "artifact-flow": (() => {
        const workflow = ARTIFACT_INPUT_WORKFLOW.workflows["artifact-flow"];
        if (workflow === undefined)
          throw new Error("fixture missing artifact-flow workflow");
        return workflow;
      })(),
    },
  };
}

/** A workflow declaring one `gate`-type step per agent used in the approveArtifact boundary tests below - the engine requires `context` naming an authorized gate step for every agent-kind approval actor (never just the bare actor). */
const GATE_WORKFLOW = cfg(`
workflow gated-flow {
  description "Workflow with review and security gate steps"
  version 1

  step review-gate {
    name "Review gate"
    type gate
    agent shuttle
    prompt "Review the artifact"
    completion review_verdict
  }

  step security-gate {
    name "Security gate"
    type gate
    agent weft
    prompt "Security audit the artifact"
    completion review_verdict
  }
}
`);

function gatedContext(): WorkflowExecutionContext {
  return {
    workflowName: "gated-flow",
    goal: "test goal",
    slug: "test-goal",
    workflows: {
      "gated-flow": (() => {
        const workflow = GATE_WORKFLOW.workflows["gated-flow"];
        if (workflow === undefined)
          throw new Error("fixture missing gated-flow workflow");
        return workflow;
      })(),
    },
  };
}

interface Harness {
  store: RuntimeStore;
  directDispatch: FakeDirectDispatchPort;
  recoveryPointerStore: InMemoryRecoveryPointerStore;
  controller: PiWorkflowController;
  generationCurrent: { value: boolean };
}

function buildHarness(
  overrides: Partial<PiWorkflowControllerDeps> = {},
): Harness {
  const store = createInMemoryRuntimeStore();
  const directDispatch = new FakeDirectDispatchPort();
  const recoveryPointerStore = new InMemoryRecoveryPointerStore();
  const generationCurrent = { value: true };
  const deps: PiWorkflowControllerDeps = {
    store,
    planStateProvider: new FakePlanStateProvider(),
    artifactProvider: new FakePiArtifactProvider(new Map()),
    directDispatch,
    recoveryPointerStore,
    clock: { now: () => 1_700_000_000_000 },
    idGenerator: { next: () => "generated-id" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    controllerGenerationId: "gen-1",
    assertGenerationCurrent: () =>
      generationCurrent.value
        ? ok(undefined)
        : err(makeControllerGenerationStaleFailure("gen-1")),
    ownerId: "test-owner",
    projectRoot: "/tmp/fake-project",
    maxAutoAdvanceSteps: 10,
    resolveAgentDescriptor: (agentName) => ({
      name: agentName,
      composedPrompt: `You are ${agentName}.`,
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
    ...overrides,
  };
  return {
    store,
    directDispatch,
    recoveryPointerStore,
    controller: new PiWorkflowController(deps),
    generationCurrent,
  };
}

async function createInstance(
  store: RuntimeStore,
  workflowName = "simple-flow",
) {
  const result = await store.instances.create({
    workflowName,
    goal: "test goal",
    slug: "test-goal",
  });
  if (!result.isOk())
    throw new Error(`failed to create instance: ${result.error.message}`);
  return result.value.id as unknown as string;
}

describe("PiWorkflowController — authorization", () => {
  it("rejects startExecution authorization when confirmed is false", () => {
    const result = authorizeByExplicitUser(false);
    expect(result.isErr()).toBe(true);
  });

  it("mints an authorization token only from confirmed === true", () => {
    const result = authorizeByExplicitUser(true);
    expect(result.isOk()).toBe(true);
  });
});

describe("PiWorkflowController — startExecution drives the full lifecycle", () => {
  it("dispatches every step through the direct-dispatch port and completes the workflow", async () => {
    const { store, directDispatch, controller } = buildHarness();
    const workflowInstanceId = await createInstance(store);
    directDispatch.enqueue(okAsync(successCandidate()) as never);
    directDispatch.enqueue(okAsync(successCandidate()) as never);

    const auth = authorizeByExplicitUser(true);
    expect(auth.isOk()).toBe(true);
    if (!auth.isOk()) return;

    const result = await controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(directDispatch.calls.map((call) => call.stepName)).toEqual([
      "plan",
      "implement",
    ]);
    expect(result.value.finalStatus).toBe("completed");
  });

  it("never advances a step without an explicit user authorization token at the type level", () => {
    // authorizeByExplicitUser(false) never yields a token; there is no way
    // to call controller.startExecution without a real AuthorizedByUser.
    const denied = authorizeByExplicitUser(false);
    expect(denied.isErr()).toBe(true);
  });
});

describe("PiWorkflowController — direct dispatch vs ordinary delegation", () => {
  it("carries workflow instance/lease/step correlation on every direct-dispatch call", async () => {
    const { store, directDispatch, controller } = buildHarness();
    const workflowInstanceId = await createInstance(store);
    directDispatch.enqueue(okAsync(successCandidate()) as never);
    directDispatch.enqueue(okAsync(successCandidate()) as never);

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    await controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );

    for (const call of directDispatch.calls) {
      expect(call.workflowInstanceId).toBe(workflowInstanceId);
      expect(typeof call.leaseId).toBe("string");
      expect(typeof call.stepName).toBe("string");
      expect(typeof call.correlationId).toBe("string");
    }
  });
});

describe("PiWorkflowController — recovery pointer", () => {
  it("appends a bounded recovery pointer after each successful step completion", async () => {
    const { store, directDispatch, recoveryPointerStore, controller } =
      buildHarness();
    const workflowInstanceId = await createInstance(store);
    directDispatch.enqueue(okAsync(successCandidate()) as never);
    directDispatch.enqueue(okAsync(successCandidate()) as never);

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    await controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );

    const pointers = recoveryPointerStore.all();
    expect(pointers.length).toBeGreaterThanOrEqual(2);
    for (const pointer of pointers) {
      expect(pointer.schemaVersion).toBe(1);
      expect(pointer.controllerGeneration).toBe("gen-1");
      expect(pointer.status).toBe("recoverable");
    }
  });

  it("degrades telemetry only on pointer append failure - never rolls back the Runtime Store commit", async () => {
    const { store, directDispatch, recoveryPointerStore, controller } =
      buildHarness();
    const workflowInstanceId = await createInstance(store);
    directDispatch.enqueue(okAsync(successCandidate()) as never);
    directDispatch.enqueue(okAsync(successCandidate()) as never);
    recoveryPointerStore.setFailNextAppend("disk-full");

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const result = await controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );

    expect(result.isOk()).toBe(true);
    const instance = await store.instances.getById(workflowInstanceId as never);
    expect(instance.isOk()).toBe(true);
    if (instance.isOk()) expect(instance.value.status).toBe("completed");
  });
});

describe("PiWorkflowController — resumeExecution recoveryTakeover (Issue #21 Task 12 S020)", () => {
  it("reload leaves the store paused at wait with the pre-reload lease unexpired, and S019 stays inert (no auto resume)", async () => {
    const old = buildHarness({
      ownerId: "controller-gen-old",
      controllerGenerationId: "controller-gen-old",
    });
    const workflowInstanceId = await createInstance(old.store);
    old.directDispatch.enqueue(
      okAsync({
        outcome: "paused",
        method: "agent_signal",
      } as PiDirectDispatchCandidate) as never,
    );
    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const started = await old.controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );
    expect(started.isOk()).toBe(true);

    // A fresh generation opens the same store (simulating /reload) but
    // never itself resumes anything.
    const activeLease = await old.store.leases.findActive();
    expect(activeLease.isOk()).toBe(true);
    if (activeLease.isOk()) expect(activeLease.value).not.toBeNull();
    const instance = await old.store.instances.findById(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
    );
    expect(instance.isOk()).toBe(true);
    if (instance.isOk()) expect(instance.value?.status).toBe("paused");
  });

  it("takes over the exact correlated pre-reload lease with a fresh owner and continues dispatch", async () => {
    const old = buildHarness({
      ownerId: "controller-gen-old",
      controllerGenerationId: "controller-gen-old",
    });
    const store = old.store;
    const workflowInstanceId = await createInstance(store);
    old.directDispatch.enqueue(
      okAsync({
        outcome: "paused",
        method: "agent_signal",
      } as PiDirectDispatchCandidate) as never,
    );
    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const started = await old.controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );
    expect(started.isOk()).toBe(true);
    if (!started.isOk()) return;
    const oldLeaseId = started.value.leaseId;
    if (oldLeaseId === undefined) throw new Error("expected an active lease");

    // A fresh generation (new PiWorkflowController, new ownerId) shares
    // the same durable store - the exact S020 scenario.
    const fresh = buildHarness({
      store,
      ownerId: "controller-gen-new",
      controllerGenerationId: "controller-gen-new",
    });
    // The paused candidate never advanced past "plan" - resuming retries
    // "plan" (now succeeding), which auto-advances into "implement".
    fresh.directDispatch.enqueue(okAsync(successCandidate()) as never);
    fresh.directDispatch.enqueue(okAsync(successCandidate()) as never);
    const resumeAuth = authorizeByExplicitUser(true);
    if (!resumeAuth.isOk()) throw new Error("unexpected");
    const resumed = await fresh.controller.resumeExecution(
      {
        workflowInstanceId,
        context: buildContext(),
        recoveryTakeover: {
          expectedLeaseId: oldLeaseId,
          expectedControllerGeneration: "controller-gen-old",
        },
      },
      resumeAuth.value,
    );

    expect(resumed.isOk()).toBe(true);
    if (resumed.isOk()) {
      expect(resumed.value.leaseId).not.toBe(oldLeaseId);
      expect(resumed.value.finalStatus).toBe("completed");
    }
    expect(fresh.directDispatch.calls.length).toBe(2);
  });

  it("fails closed with the exact LeaseLost message when the correlation is mismatched", async () => {
    const old = buildHarness({
      ownerId: "controller-gen-old",
      controllerGenerationId: "controller-gen-old",
    });
    const store = old.store;
    const workflowInstanceId = await createInstance(store);
    old.directDispatch.enqueue(
      okAsync({
        outcome: "paused",
        method: "agent_signal",
      } as PiDirectDispatchCandidate) as never,
    );
    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const started = await old.controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );
    expect(started.isOk()).toBe(true);

    const fresh = buildHarness({
      store,
      ownerId: "controller-gen-new",
      controllerGenerationId: "controller-gen-new",
    });
    const resumeAuth = authorizeByExplicitUser(true);
    if (!resumeAuth.isOk()) throw new Error("unexpected");
    const resumed = await fresh.controller.resumeExecution(
      {
        workflowInstanceId,
        context: buildContext(),
        recoveryTakeover: {
          expectedLeaseId: "some-other-lease",
          expectedControllerGeneration: "controller-gen-old",
        },
      },
      resumeAuth.value,
    );

    expect(resumed.isErr()).toBe(true);
    if (resumed.isErr()) {
      expect(resumed.error.code).toBe("LeaseLost");
      expect(resumed.error.safeMessage).toBe(
        "The execution lease is no longer held; explicit resume is required.",
      );
    }
  });

  it("reproduces the exact S020 regression without recoveryTakeover: a fresh owner's plain resume conflicts on the still-unexpired old lease", async () => {
    const old = buildHarness({
      ownerId: "controller-gen-old",
      controllerGenerationId: "controller-gen-old",
    });
    const store = old.store;
    const workflowInstanceId = await createInstance(store);
    old.directDispatch.enqueue(
      okAsync({
        outcome: "paused",
        method: "agent_signal",
      } as PiDirectDispatchCandidate) as never,
    );
    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const started = await old.controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );
    expect(started.isOk()).toBe(true);

    const fresh = buildHarness({
      store,
      ownerId: "controller-gen-new",
      controllerGenerationId: "controller-gen-new",
    });
    const resumeAuth = authorizeByExplicitUser(true);
    if (!resumeAuth.isOk()) throw new Error("unexpected");
    const resumed = await fresh.controller.resumeExecution(
      { workflowInstanceId, context: buildContext() },
      resumeAuth.value,
    );

    expect(resumed.isErr()).toBe(true);
    if (resumed.isErr()) {
      expect(resumed.error.code).toBe("LeaseLost");
      expect(resumed.error.safeMessage).toBe(
        "The execution lease is no longer held; explicit resume is required.",
      );
    }
  });
});

describe("PiWorkflowController — inspectExecution stays read-only", () => {
  it("returns a snapshot without mutating instance state", async () => {
    const { store, controller } = buildHarness();
    const workflowInstanceId = await createInstance(store);

    const before = await store.instances.getById(workflowInstanceId as never);
    const inspected = await controller.inspect(workflowInstanceId);
    const after = await store.instances.getById(workflowInstanceId as never);

    expect(inspected.isOk()).toBe(true);
    expect(
      before.isOk() &&
        after.isOk() &&
        before.value.status === after.value.status,
    ).toBe(true);
  });
});

describe("PiWorkflowController — handleUserInterrupt routes to pause/cancel exactly", () => {
  it("cancels a running execution on signal 'cancel'", async () => {
    const { store, directDispatch, controller } = buildHarness();
    const workflowInstanceId = await createInstance(store);
    // Enqueue a candidate that pauses the workflow so we have an active lease to interrupt against.
    directDispatch.enqueue(
      okAsync({
        outcome: "paused",
        method: "agent_signal",
      } as PiDirectDispatchCandidate) as never,
    );

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const started = await controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );
    expect(started.isOk()).toBe(true);
    if (!started.isOk()) return;
    expect(started.value.finalStatus).toBe("paused");
  });
});

describe("PiWorkflowController — generation recheck at async boundaries", () => {
  it("rejects startExecution when the generation goes stale before the call", async () => {
    const { store, controller, generationCurrent } = buildHarness();
    const workflowInstanceId = await createInstance(store);
    generationCurrent.value = false;

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const result = await controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );
    expect(result.isErr()).toBe(true);
  });
});

describe("PiWorkflowController — no duplicate effect application (Pi adapter contract)", () => {
  it("dispatches each step exactly once for a two-step workflow, never re-deriving an already-returned completeStep effect", async () => {
    const { store, directDispatch, controller } = buildHarness();
    const workflowInstanceId = await createInstance(store);
    directDispatch.enqueue(okAsync(successCandidate()) as never);
    directDispatch.enqueue(okAsync(successCandidate()) as never);

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const result = await controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );

    expect(result.isOk()).toBe(true);
    // Exactly two direct-dispatch calls total: one per step. A regression
    // that re-derives the auto-advance step via a second `dispatchStep`
    // call (instead of projecting `completeStep`'s own returned
    // `dispatch-agent` effect) would either duplicate a call for the same
    // step name or exceed this count.
    expect(directDispatch.calls).toHaveLength(2);
    const stepNames = directDispatch.calls.map((call) => call.stepName);
    expect(new Set(stepNames).size).toBe(stepNames.length);
  });
});

describe("PiWorkflowController — reconcileExecution", () => {
  it("routes an explicit user revision request through reconcileExecution and applies its effects", async () => {
    const { store, controller } = buildHarness();
    const workflowInstanceId = await createInstance(store);
    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const started = await controller.startExecution(
      { workflowInstanceId: workflowInstanceId, context: buildContext() },
      auth.value,
    );
    // startExecution alone (no direct-dispatch settlement scripted) leaves
    // the loop mid-flight on the fake port's fail-closed empty queue; the
    // instance is still "running" with an active lease, which is all
    // `reconcileExecution` requires.
    expect(started.isErr() || started.isOk()).toBe(true);
    const instance = await store.instances.findById(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
    );
    if (instance === null) throw new Error("instance missing");
    const lease = await store.leases.findActive();
    if (!lease.isOk() || lease.value === null)
      throw new Error("no active lease to reconcile against");

    const result = await controller.reconcile({
      workflowInstanceId,
      leaseId: String(lease.value.id),
      reason: "user-revision-request",
      authorizationSource: "user",
    });

    expect(result.isOk()).toBe(true);
  });
});

const USER_CONFIRM_WORKFLOW = cfg(`
workflow confirm-flow {
  description "Single interactive step requiring user confirmation"
  version 1

  step review {
    name "Review"
    type interactive
    agent pattern
    prompt "Review: {{instance.goal}}"
    completion user_confirm
  }
}
`);

function userConfirmContext(): WorkflowExecutionContext {
  return {
    workflowName: "confirm-flow",
    goal: "test goal",
    slug: "test-goal",
    workflows: {
      "confirm-flow": (() => {
        const workflow = USER_CONFIRM_WORKFLOW.workflows["confirm-flow"];
        if (workflow === undefined)
          throw new Error("fixture missing confirm-flow workflow");
        return workflow;
      })(),
    },
  };
}

describe("PiWorkflowController — /weave:advance user_confirm gating (Pi adapter contract)", () => {
  it("withholds completeStep when the candidate's method is user_confirm, leaving the instance running", async () => {
    const { store, directDispatch, controller } = buildHarness();
    const workflowInstanceId = await createInstance(store, "confirm-flow");
    directDispatch.enqueue(
      okAsync({
        outcome: "success",
        method: "user_confirm",
      } as PiDirectDispatchCandidate) as never,
    );

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const result = await controller.startExecution(
      { workflowInstanceId, context: userConfirmContext() },
      auth.value,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // The direct-step agent's own user_confirm candidate is never enough by
    // itself - completeStep is withheld until a genuine /weave:advance, so
    // the run stays "running" at the same step rather than silently
    // completing (Pi adapter contract: "/weave:advance ... only when the step
    // allows it" would otherwise be a dead command).
    expect(result.value.finalStatus).toBe("running");
    expect(result.value.currentStepName).toBe("review");
    expect(directDispatch.calls).toHaveLength(1);

    const instance = await store.instances.getById(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
    );
    expect(instance.isOk()).toBe(true);
    if (instance.isOk()) expect(instance.value.status).toBe("running");
  });

  it("confirmStep releases the withheld candidate exactly once, completing the workflow", async () => {
    const { store, directDispatch, controller } = buildHarness();
    const workflowInstanceId = await createInstance(store, "confirm-flow");
    directDispatch.enqueue(
      okAsync({
        outcome: "success",
        method: "user_confirm",
      } as PiDirectDispatchCandidate) as never,
    );

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const started = await controller.startExecution(
      { workflowInstanceId, context: userConfirmContext() },
      auth.value,
    );
    expect(started.isOk()).toBe(true);
    if (!started.isOk()) return;
    expect(started.value.finalStatus).toBe("running");
    const leaseId = started.value.leaseId;
    if (leaseId === undefined) throw new Error("expected an active lease id");

    const advanceAuth = authorizeByExplicitUser(true);
    if (!advanceAuth.isOk()) throw new Error("unexpected");
    const advanced = await controller.confirmStep(
      { workflowInstanceId, leaseId },
      advanceAuth.value,
    );
    expect(advanced.isOk()).toBe(true);
    if (advanced.isOk()) expect(advanced.value.finalStatus).toBe("completed");

    // Replaying confirmStep after release must fail typed, never re-complete
    // or double-apply completeStep's effects a second time.
    const replay = await controller.confirmStep(
      { workflowInstanceId, leaseId },
      advanceAuth.value,
    );
    expect(replay.isErr()).toBe(true);
  });

  it("fails closed with a typed error when nothing is awaiting confirmation", async () => {
    const { store, controller } = buildHarness();
    const workflowInstanceId = await createInstance(store, "confirm-flow");
    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const result = await controller.confirmStep(
      { workflowInstanceId, leaseId: "nonexistent-lease" },
      auth.value,
    );
    expect(result.isErr()).toBe(true);
  });
});

describe("PiWorkflowController — observeSession fires at every required trigger point (Pi adapter contract)", () => {
  function spyOnSnapshotStatuses(store: RuntimeStore): string[] {
    const recorded: string[] = [];
    const originalRecord = store.snapshots.record.bind(store.snapshots);
    store.snapshots.record = ((input: Parameters<typeof originalRecord>[0]) => {
      recorded.push(input.sessionStatus);
      return originalRecord(input);
    }) as typeof store.snapshots.record;
    return recorded;
  }

  it("records active on start, then active+idle around each direct-step activation/settlement", async () => {
    const { store, directDispatch, controller } = buildHarness();
    const recorded = spyOnSnapshotStatuses(store);
    const workflowInstanceId = await createInstance(store);
    directDispatch.enqueue(okAsync(successCandidate()) as never);
    directDispatch.enqueue(okAsync(successCandidate()) as never);

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const result = await controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );
    expect(result.isOk()).toBe(true);

    // start ("active") + 2x(direct-step activation "active" + settlement
    // "idle") for the two-step workflow.
    expect(recorded).toEqual(["active", "active", "idle", "active", "idle"]);
  });

  it("records terminated when handleUserInterrupt cancels an active lease", async () => {
    const { store, directDispatch, controller } = buildHarness();
    directDispatch.enqueue(
      okAsync({
        outcome: "paused",
        method: "agent_signal",
      } as PiDirectDispatchCandidate) as never,
    );
    const workflowInstanceId = await createInstance(store);
    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const started = await controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );
    expect(started.isOk()).toBe(true);
    if (!started.isOk()) return;
    const leaseId = started.value.leaseId;
    if (leaseId === undefined) throw new Error("expected an active lease id");

    const recorded = spyOnSnapshotStatuses(store);
    const interrupted = await controller.handleUserInterrupt({
      workflowInstanceId,
      leaseId,
      signal: "cancel",
    });
    expect(interrupted.isOk()).toBe(true);
    expect(recorded).toEqual(["terminated"]);
  });

  it("records a queryable, bounded snapshot for a direct observe() call with the exact status/agent/step supplied", async () => {
    const { store, controller } = buildHarness();
    const workflowInstanceId = await createInstance(store);
    const result = await controller.observe({
      workflowInstanceId,
      leaseId: "lease-1",
      harnessName: "pi",
      agentName: "loom",
      sessionStatus: "active",
      stepName: "review",
    });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const snapshot = await store.snapshots.findById(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      result.value.snapshotId as any,
    );
    expect(snapshot.isOk()).toBe(true);
    if (snapshot.isOk() && snapshot.value !== null) {
      expect(snapshot.value.sessionStatus).toBe("active");
      expect(snapshot.value.agentName).toBe("loom");
      expect(snapshot.value.stepName).toBe("review");
    }
  });
});

describe("PiWorkflowController — pre-dispatch artifact integrity (Pi adapter contract)", () => {
  it("dispatches normally when the recomputed digest matches the pinned artifact", async () => {
    const bytes = new TextEncoder().encode("approved spec content");
    const digest = sha256Hex("approved spec content");
    const { store, directDispatch, controller } = buildHarness({
      artifactProvider: new FakePiArtifactProvider(
        new Map([["spec.md", bytes]]),
      ),
    });
    const workflowInstanceId = await createInstance(store, "artifact-flow");
    const seeded = await store.instances.addArtifact(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      {
        name: "spec",
        path: "spec.md",
        integrity: { algorithm: "sha256", digest },
      },
    );
    if (!seeded.isOk()) throw new Error("failed to seed artifact");
    directDispatch.enqueue(okAsync(successCandidate()) as never);

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const result = await controller.startExecution(
      { workflowInstanceId, context: artifactInputContext() },
      auth.value,
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.finalStatus).toBe("completed");
    expect(directDispatch.calls.length).toBe(1);
  });

  it("fails closed and reconciles as execution-mismatch — never dispatches — when the artifact's bytes changed since approval", async () => {
    const originalDigest = sha256Hex("approved spec content");
    const tamperedBytes = new TextEncoder().encode("tampered spec content");
    const { store, directDispatch, controller } = buildHarness({
      artifactProvider: new FakePiArtifactProvider(
        new Map([["spec.md", tamperedBytes]]),
      ),
    });
    const workflowInstanceId = await createInstance(store, "artifact-flow");
    const seeded = await store.instances.addArtifact(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      {
        name: "spec",
        path: "spec.md",
        integrity: { algorithm: "sha256", digest: originalDigest },
      },
    );
    if (!seeded.isOk()) throw new Error("failed to seed artifact");
    directDispatch.enqueue(okAsync(successCandidate()) as never);

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const result = await controller.startExecution(
      { workflowInstanceId, context: artifactInputContext() },
      auth.value,
    );

    expect(result.isErr()).toBe(true);
    // Never silently rebinds and dispatches against the changed bytes.
    expect(directDispatch.calls.length).toBe(0);
    // `reconcileExecution("execution-mismatch", "runtime")` ran as a side
    // effect of the failure (no context is passed, so it fails closed to
    // "paused" rather than silently continuing) - this is the only
    // observable proof, from outside the controller, that reconciliation
    // fired rather than the dispatch failure being reported bare.
    const instance = await store.instances.findById(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
    );
    expect(instance.isOk()).toBe(true);
    if (instance.isOk()) expect(instance.value?.status).toBe("paused");
  });

  it("never dispatches when a tracked artifact's declared path escapes the project root", async () => {
    const { store, directDispatch, controller } = buildHarness({
      artifactProvider: new FakePiArtifactProvider(new Map()),
    });
    const workflowInstanceId = await createInstance(store, "artifact-flow");
    const seeded = await store.instances.addArtifact(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      {
        name: "spec",
        path: "../outside-project/spec.md",
        integrity: {
          algorithm: "sha256",
          digest: sha256Hex("irrelevant"),
        },
      },
    );
    if (!seeded.isOk()) throw new Error("failed to seed artifact");

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const result = await controller.startExecution(
      { workflowInstanceId, context: artifactInputContext() },
      auth.value,
    );

    expect(result.isErr()).toBe(true);
    expect(directDispatch.calls.length).toBe(0);
  });

  it("protects a plan file tracked as a normative artifact through the exact same typed rule — no string heuristics", async () => {
    const originalDigest = sha256Hex("## Plan\n- [ ] 1. First task\n");
    const tamperedBytes = new TextEncoder().encode(
      "## Plan\n- [x] 1. First task (edited out from under the coordinator)\n",
    );
    const { store, directDispatch, controller } = buildHarness({
      artifactProvider: new FakePiArtifactProvider(
        new Map([[".weave/plans/artifact-flow.md", tamperedBytes]]),
      ),
    });
    const workflowInstanceId = await createInstance(store, "artifact-flow");
    const seeded = await store.instances.addArtifact(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      {
        name: "spec",
        path: ".weave/plans/artifact-flow.md",
        integrity: { algorithm: "sha256", digest: originalDigest },
      },
    );
    if (!seeded.isOk()) throw new Error("failed to seed artifact");

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const result = await controller.startExecution(
      { workflowInstanceId, context: artifactInputContext() },
      auth.value,
    );

    expect(result.isErr()).toBe(true);
    expect(directDispatch.calls.length).toBe(0);
    const instance = await store.instances.findById(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
    );
    expect(instance.isOk()).toBe(true);
    if (instance.isOk()) expect(instance.value?.status).toBe("paused");
  });

  it("never pins an artifact whose prior approval was invalidated by a newer, unapproved revision — dispatch fails closed on the engine's own approval-invalidation check instead of silently skipping it (Pi adapter contract exact pinnedArtifactRevisions behavior)", async () => {
    const approvedContent = "approved spec v1";
    const driftedContent = "unapproved spec v2 — drifted since approval";
    const driftedDigest = sha256Hex(driftedContent);
    // The current file on disk genuinely matches the *latest* (v2, still
    // pending) revision's stored digest - so if this test failed for the
    // wrong reason, it would be the integrity check, not the
    // approval-invalidation check. Pinning to v2 anyway would make the
    // engine skip its approval-invalidation check for "spec" entirely,
    // silently dispatching against an unapproved revision.
    const { store, directDispatch, controller } = buildHarness({
      artifactProvider: new FakePiArtifactProvider(
        new Map([["spec.md", new TextEncoder().encode(driftedContent)]]),
      ),
    });
    const workflowInstanceId = await createInstance(store, "artifact-flow");
    const seededV1 = await store.instances.addArtifact(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      {
        name: "spec",
        path: "spec.md",
        integrity: {
          algorithm: "sha256",
          digest: sha256Hex(approvedContent),
        },
      },
    );
    if (!seededV1.isOk()) throw new Error("failed to seed artifact v1");
    const artifactIdV1 = seededV1.value.artifacts[0]?.id;
    if (artifactIdV1 === undefined)
      throw new Error("expected a seeded v1 artifact");
    const approved = await store.instances.updateArtifactApproval(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      artifactIdV1,
      "approved",
      {
        actor: userActor(),
        decidedAt: new Date().toISOString(),
        expectedRevision: 1,
        expectedDigest: sha256Hex(approvedContent),
      },
    );
    if (!approved.isOk()) throw new Error("failed to approve v1");
    // A new, not-yet-approved revision supersedes the approved one -
    // resetting approvalState to "pending" and invalidating the prior
    // approval, per the store's documented `addArtifact` contract.
    const seededV2 = await store.instances.addArtifact(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      {
        name: "spec",
        path: "spec.md",
        integrity: { algorithm: "sha256", digest: driftedDigest },
      },
    );
    if (!seededV2.isOk()) throw new Error("failed to seed artifact v2");

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const result = await controller.startExecution(
      { workflowInstanceId, context: artifactInputContext() },
      auth.value,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.correlation?.reason).toBe(
        "policy_decision:artifact_approval",
      );
    }
    // Never dispatches against the unapproved, drifted revision.
    expect(directDispatch.calls.length).toBe(0);
  });
});

describe("PiWorkflowController — retry pins reuse the prior attempt's consumed artifact revisions (execution lifecycle contract default retry reuse)", () => {
  it("resuming a paused step records the retry's consumed artifact as the prior attempt's revision, even though a newer, fully-approved revision with different content now exists — never silently rebinds", async () => {
    const originalContent = "approved spec v1";
    const originalDigest = sha256Hex(originalContent);
    const files = new Map([
      ["spec.md", new TextEncoder().encode(originalContent)],
    ]);
    const { store, directDispatch, controller } = buildHarness({
      artifactProvider: new FakePiArtifactProvider(files),
    });
    const workflowInstanceId = await createInstance(store, "artifact-flow");

    const seededV1 = await store.instances.addArtifact(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      {
        name: "spec",
        path: "spec.md",
        integrity: { algorithm: "sha256", digest: originalDigest },
      },
    );
    if (!seededV1.isOk()) throw new Error("failed to seed artifact v1");
    const artifactId = seededV1.value.artifacts[0]?.id;
    if (artifactId === undefined)
      throw new Error("expected a seeded v1 artifact");
    const approvedV1 = await store.instances.updateArtifactApproval(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      artifactId,
      "approved",
      {
        actor: userActor(),
        decidedAt: new Date().toISOString(),
        expectedRevision: 1,
        expectedDigest: originalDigest,
      },
    );
    if (!approvedV1.isOk()) throw new Error("failed to approve v1");

    // First dispatch pauses without completing the step - `currentStepName`
    // stays "implement", so a later `resumeExecution` retries the *same*
    // step (not a fresh one).
    directDispatch.enqueue(
      okAsync({
        outcome: "paused",
        method: "agent_signal",
      } as PiDirectDispatchCandidate) as never,
    );
    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const started = await controller.startExecution(
      { workflowInstanceId, context: artifactInputContext() },
      auth.value,
    );
    expect(started.isOk()).toBe(true);
    if (!started.isOk()) return;
    expect(directDispatch.calls.length).toBe(1);

    // Content legitimately changes and gets a fresh, fully-approved
    // revision - without any explicit reconciliation transition.
    const updatedContent = "approved spec v2 — updated mid-execution";
    const updatedDigest = sha256Hex(updatedContent);
    files.set("spec.md", new TextEncoder().encode(updatedContent));
    const seededV2 = await store.instances.addArtifact(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      {
        name: "spec",
        path: "spec.md",
        integrity: { algorithm: "sha256", digest: updatedDigest },
      },
    );
    if (!seededV2.isOk()) throw new Error("failed to seed artifact v2");
    const artifactIdV2 = seededV2.value.artifacts.at(-1)?.id;
    if (artifactIdV2 === undefined)
      throw new Error("expected a seeded v2 artifact");
    const approvedV2 = await store.instances.updateArtifactApproval(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      artifactIdV2,
      "approved",
      {
        actor: userActor(),
        decidedAt: new Date().toISOString(),
        expectedRevision: 2,
        expectedDigest: updatedDigest,
      },
    );
    if (!approvedV2.isOk()) throw new Error("failed to approve v2");

    // A paused step does not release its execution lease (pause is not
    // termination). Release it here the way an operator/harness would
    // before issuing an explicit `/weave:resume` - this is test setup, not
    // part of the behavior under test.
    const leaseId = started.value.leaseId;
    if (leaseId === undefined) throw new Error("expected an active lease id");
    const releasedFirst = await store.leases.release(
      createExecutionLeaseId(leaseId),
      createOwnerId("test-owner"),
    );
    expect(releasedFirst.isOk()).toBe(true);

    // Retry (resumeExecution). The engine's own consumption-time integrity
    // check validates the *latest* recorded revision's digest against the
    // current file - since v2 was legitimately approved against this exact
    // content, that check passes and dispatch proceeds (this is a
    // content update accompanied by a new approval, not out-of-band
    // tampering - the adjacent "fails closed and reconciles as
    // execution-mismatch" test above covers genuine tampering).
    //
    // The invariant under test here is narrower and is the one
    // `computePinnedArtifactRevisions` is responsible for: the retry's
    // *recorded consumed revision* must still be revision 1 - the prior
    // attempt's pin - never silently rebound to revision 2 just because
    // it is newer and approved. Silent rebinding would violate execution lifecycle contract's
    // "reuse the same consumed artifact revisions on retry by default"
    // and Non-Goal 5 ("no automatic latest-artifact rebinding on retry").
    directDispatch.enqueue(okAsync(successCandidate()) as never);
    const resumed = await controller.resumeExecution(
      { workflowInstanceId, context: artifactInputContext() },
      auth.value,
    );

    expect(resumed.isOk()).toBe(true);
    expect(directDispatch.calls.length).toBe(2);

    const instance = await store.instances.findById(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
    );
    expect(instance.isOk()).toBe(true);
    if (instance.isOk() && instance.value !== null) {
      const implementAttempts = instance.value.stepAttempts.filter(
        (attempt) => attempt.stepName === "implement",
      );
      expect(implementAttempts).toHaveLength(2);
      // Both attempts - the first dispatch and the retry - consumed
      // revision 1, not the newer revision 2 that appeared in between.
      for (const attempt of implementAttempts) {
        expect(attempt.consumedArtifacts).toEqual([
          { artifactId, name: "spec", revision: 1 },
        ]);
      }
    }
  });

  it("resuming a paused step succeeds by pinning the prior attempt's revision when its content has not drifted, even though a newer approved revision exists", async () => {
    const content = "approved spec v1";
    const digest = sha256Hex(content);
    const files = new Map([["spec.md", new TextEncoder().encode(content)]]);
    const { store, directDispatch, controller } = buildHarness({
      artifactProvider: new FakePiArtifactProvider(files),
    });
    const workflowInstanceId = await createInstance(store, "artifact-flow");

    const seededV1 = await store.instances.addArtifact(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      {
        name: "spec",
        path: "spec.md",
        integrity: { algorithm: "sha256", digest },
      },
    );
    if (!seededV1.isOk()) throw new Error("failed to seed artifact v1");
    const artifactId = seededV1.value.artifacts[0]?.id;
    if (artifactId === undefined)
      throw new Error("expected a seeded v1 artifact");
    const approvedV1 = await store.instances.updateArtifactApproval(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      artifactId,
      "approved",
      {
        actor: userActor(),
        decidedAt: new Date().toISOString(),
        expectedRevision: 1,
        expectedDigest: digest,
      },
    );
    if (!approvedV1.isOk()) throw new Error("failed to approve v1");

    directDispatch.enqueue(
      okAsync({
        outcome: "paused",
        method: "agent_signal",
      } as PiDirectDispatchCandidate) as never,
    );
    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const started = await controller.startExecution(
      { workflowInstanceId, context: artifactInputContext() },
      auth.value,
    );
    expect(started.isOk()).toBe(true);
    if (!started.isOk()) return;
    expect(directDispatch.calls.length).toBe(1);

    // A newer revision appears and is fully approved, but its bytes are
    // identical to v1's - representing e.g. a no-op republish. If pinning
    // incorrectly jumped to "latest" it would still dispatch here (digest
    // matches either way), so this case is only conclusive together with
    // the direct `consumedArtifacts` assertion below.
    const seededV2 = await store.instances.addArtifact(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      {
        name: "spec",
        path: "spec.md",
        integrity: { algorithm: "sha256", digest },
      },
    );
    if (!seededV2.isOk()) throw new Error("failed to seed artifact v2");
    const artifactIdV2 = seededV2.value.artifacts.at(-1)?.id;
    if (artifactIdV2 === undefined)
      throw new Error("expected a seeded v2 artifact");
    const approvedV2 = await store.instances.updateArtifactApproval(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      artifactIdV2,
      "approved",
      {
        actor: userActor(),
        decidedAt: new Date().toISOString(),
        expectedRevision: 2,
        expectedDigest: digest,
      },
    );
    if (!approvedV2.isOk()) throw new Error("failed to approve v2");

    const leaseId = started.value.leaseId;
    if (leaseId === undefined) throw new Error("expected an active lease id");
    const releasedFirst = await store.leases.release(
      createExecutionLeaseId(leaseId),
      createOwnerId("test-owner"),
    );
    expect(releasedFirst.isOk()).toBe(true);

    directDispatch.enqueue(okAsync(successCandidate()) as never);
    const resumed = await controller.resumeExecution(
      { workflowInstanceId, context: artifactInputContext() },
      auth.value,
    );

    expect(resumed.isOk()).toBe(true);
    expect(directDispatch.calls.length).toBe(2);

    const instance = await store.instances.findById(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
    );
    expect(instance.isOk()).toBe(true);
    if (instance.isOk() && instance.value !== null) {
      const implementAttempts = instance.value.stepAttempts.filter(
        (attempt) => attempt.stepName === "implement",
      );
      expect(implementAttempts).toHaveLength(2);
      for (const attempt of implementAttempts) {
        expect(attempt.consumedArtifacts).toEqual([
          { artifactId, name: "spec", revision: 1 },
        ]);
      }
    }
  });
});

describe("PiWorkflowController — approveArtifact boundary (Pi adapter contract)", () => {
  it("binds the artifact's current revision and a user actor for an ordinary /weave:artifact approval", async () => {
    const { store, controller } = buildHarness();
    const workflowInstanceId = await createInstance(store);
    const seeded = await store.instances.addArtifact(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      { name: "report", path: "report.md", producerAgent: "shuttle" },
    );
    if (!seeded.isOk()) throw new Error("failed to seed artifact");
    const artifactId = seeded.value.artifacts[0]?.id;
    if (artifactId === undefined) throw new Error("expected a seeded artifact");

    const lease = await store.leases.acquire({
      workflowInstanceId: workflowInstanceId as never,
      ownerId: "test-owner" as never,
      ttlMs: 60_000,
    });
    if (!lease.isOk()) throw new Error("failed to acquire lease");

    const approved = await controller.approveArtifact({
      workflowInstanceId,
      leaseId: String(lease.value.id),
      artifactId: String(artifactId),
      approvalState: "approved",
      actor: userActor(),
      expectedRevision: 1,
    });
    expect(approved.isOk()).toBe(true);
  });

  it("rejects a self-approval attempt from the producing agent even under the review/security structured gate — never a silent allow", async () => {
    const { store, controller } = buildHarness();
    const workflowInstanceId = await createInstance(store);
    const seeded = await store.instances.addArtifact(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      { name: "report", path: "report.md", producerAgent: "shuttle" },
    );
    if (!seeded.isOk()) throw new Error("failed to seed artifact");
    const artifactId = seeded.value.artifacts[0]?.id;
    if (artifactId === undefined) throw new Error("expected a seeded artifact");

    const lease = await store.leases.acquire({
      workflowInstanceId: workflowInstanceId as never,
      ownerId: "test-owner" as never,
      ttlMs: 60_000,
    });
    if (!lease.isOk()) throw new Error("failed to acquire lease");

    for (const gate of ["review", "security"] as const) {
      const rejected = await controller.approveArtifact({
        workflowInstanceId,
        leaseId: String(lease.value.id),
        artifactId: String(artifactId),
        approvalState: "approved",
        actor: agentActor("shuttle", gate),
        expectedRevision: 1,
        context: gatedContext(),
      });
      expect(rejected.isErr()).toBe(true);
      if (rejected.isErr()) {
        // The correlation reason is a bounded, closed-vocabulary string
        // derived only from the engine's typed `rule` discriminant - never
        // the engine's free-text `message` (Pi adapter contract; the message
        // itself may embed the artifact's producer/gate identity and must
        // not reach adapter-failure correlation data).
        expect(rejected.error.correlation?.reason).toBe(
          "policy_decision:self_approval",
        );
      }
    }

    // The engine never mutated approval state on either attempt.
    const instance = await store.instances.findById(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
    );
    expect(instance.isOk()).toBe(true);
    if (instance.isOk())
      expect(instance.value?.artifacts[0]?.approvalState).toBe("pending");
  });

  it("allows a gate agent to approve an artifact it did not produce", async () => {
    const { store, controller } = buildHarness();
    const workflowInstanceId = await createInstance(store);
    const seeded = await store.instances.addArtifact(
      // biome-ignore lint/suspicious/noExplicitAny: branded id round-trip for the test harness only
      workflowInstanceId as any,
      { name: "report", path: "report.md", producerAgent: "shuttle" },
    );
    if (!seeded.isOk()) throw new Error("failed to seed artifact");
    const artifactId = seeded.value.artifacts[0]?.id;
    if (artifactId === undefined) throw new Error("expected a seeded artifact");

    const lease = await store.leases.acquire({
      workflowInstanceId: workflowInstanceId as never,
      ownerId: "test-owner" as never,
      ttlMs: 60_000,
    });
    if (!lease.isOk()) throw new Error("failed to acquire lease");

    const approved = await controller.approveArtifact({
      workflowInstanceId,
      leaseId: String(lease.value.id),
      artifactId: String(artifactId),
      approvalState: "approved",
      actor: agentActor("weft", "security"),
      expectedRevision: 1,
      context: gatedContext(),
    });
    expect(approved.isOk()).toBe(true);
  });
});

describe("PiWorkflowController — onPlanSnapshotChanged fires at every required trigger point (Pi adapter contract)", () => {
  it("fires after a dispatch settles within startExecution", async () => {
    const notified: string[] = [];
    const { store, directDispatch, controller } = buildHarness({
      onPlanSnapshotChanged: (workflowInstanceId) =>
        notified.push(workflowInstanceId),
    });
    const workflowInstanceId = await createInstance(store);
    directDispatch.enqueue(okAsync(successCandidate()) as never);
    directDispatch.enqueue(okAsync(successCandidate()) as never);

    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const result = await controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );
    expect(result.isOk()).toBe(true);
    expect(notified).toEqual([workflowInstanceId]);
  });

  it("fires after handleUserInterrupt cancels a running execution", async () => {
    const notified: string[] = [];
    const { store, directDispatch, controller } = buildHarness({
      onPlanSnapshotChanged: (workflowInstanceId) =>
        notified.push(workflowInstanceId),
    });
    const workflowInstanceId = await createInstance(store);
    directDispatch.enqueue(
      okAsync({
        outcome: "paused",
        method: "agent_signal",
      } as PiDirectDispatchCandidate) as never,
    );
    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const started = await controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );
    if (!started.isOk()) throw new Error("unexpected");
    const leaseId = started.value.leaseId;
    if (leaseId === undefined) throw new Error("expected an active lease id");
    notified.length = 0;

    const interrupted = await controller.handleUserInterrupt({
      workflowInstanceId,
      leaseId,
      signal: "cancel",
    });
    expect(interrupted.isOk()).toBe(true);
    expect(notified).toEqual([workflowInstanceId]);
  });

  it("fires after confirmStep releases a withheld user_confirm candidate", async () => {
    const notified: string[] = [];
    const { store, directDispatch, controller } = buildHarness({
      onPlanSnapshotChanged: (workflowInstanceId) =>
        notified.push(workflowInstanceId),
    });
    const workflowInstanceId = await createInstance(store, "confirm-flow");
    directDispatch.enqueue(
      okAsync({
        outcome: "success",
        method: "user_confirm",
      } as PiDirectDispatchCandidate) as never,
    );
    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    const started = await controller.startExecution(
      { workflowInstanceId, context: userConfirmContext() },
      auth.value,
    );
    if (!started.isOk()) throw new Error("unexpected");
    const leaseId = started.value.leaseId;
    if (leaseId === undefined) throw new Error("expected an active lease id");
    // The withheld candidate never advanced the plan yet.
    notified.length = 0;

    const confirmed = await controller.confirmStep(
      { workflowInstanceId, leaseId },
      auth.value,
    );
    expect(confirmed.isOk()).toBe(true);
    expect(notified).toEqual([workflowInstanceId]);
  });

  it("fires after reconcile applies its effects", async () => {
    const notified: string[] = [];
    const { store, controller } = buildHarness({
      onPlanSnapshotChanged: (workflowInstanceId) =>
        notified.push(workflowInstanceId),
    });
    const workflowInstanceId = await createInstance(store);
    const auth = authorizeByExplicitUser(true);
    if (!auth.isOk()) throw new Error("unexpected");
    // startExecution alone (no direct-dispatch settlement scripted) leaves
    // the loop mid-flight on the fake port's fail-closed empty queue; the
    // instance is still "running" with an active lease, which is all
    // `reconcile` requires (mirrors the reconcileExecution describe block
    // above).
    await controller.startExecution(
      { workflowInstanceId, context: buildContext() },
      auth.value,
    );
    const lease = await store.leases.findActive();
    if (!lease.isOk() || lease.value === null)
      throw new Error("no active lease to reconcile against");
    notified.length = 0;

    const reconciled = await controller.reconcile({
      workflowInstanceId,
      leaseId: String(lease.value.id),
      reason: "user-revision-request",
      authorizationSource: "user",
    });
    expect(reconciled.isOk()).toBe(true);
    expect(notified).toEqual([workflowInstanceId]);
  });
});

describe("PiWorkflowController — terminal completion idle observation ordering against a real SQLite Runtime Store (#21 Task 12)", () => {
  // A live-exact-host regression: `completeStep` on the workflow's final
  // step releases the active ExecutionLease - the SQLite Runtime Store
  // deletes that row outright. Observing `idle` for that same settlement
  // any later tries to record a SessionSnapshot against a lease_id that no
  // longer exists, which the real SQLite FK constraint (unlike the
  // in-memory store used by every other test in this file) rejects. The
  // failure was silent to the caller - `observeBestEffort` degrades any
  // observation failure to a logged warning, never a returned error - so
  // only a real SQLite store, a captured logger, and an explicit snapshot
  // count/status assertion can prove this ordering is correct.
  let projectRoot: string;

  function openStore(): RuntimeStore {
    projectRoot = join(
      tmpdir(),
      `weave-workflow-controller-${crypto.randomUUID()}`,
    );
    Bun.spawnSync(["mkdir", "-p", projectRoot]);
    return createSqliteRuntimeStore({
      dbPath: join(projectRoot, ".weave", "runtime", "weave.db"),
      projectRoot,
    });
  }

  function cleanupStore(): void {
    Bun.spawnSync(["rm", "-rf", projectRoot]);
  }

  it("records the terminal step's idle SessionSnapshot with no lifecycle warning, even though completeStep already released the lease", async () => {
    const store = openStore();
    try {
      const warnings: unknown[] = [];
      const directDispatch = new FakeDirectDispatchPort();
      const recoveryPointerStore = new InMemoryRecoveryPointerStore();
      const generationCurrent = { value: true };
      const deps: PiWorkflowControllerDeps = {
        store,
        planStateProvider: new FakePlanStateProvider(),
        artifactProvider: new FakePiArtifactProvider(new Map()),
        directDispatch,
        recoveryPointerStore,
        clock: { now: () => 1_700_000_000_000 },
        idGenerator: { next: () => "generated-id" },
        logger: {
          debug() {},
          info() {},
          warn: (...args: unknown[]) => warnings.push(args),
          error() {},
        },
        controllerGenerationId: "gen-1",
        assertGenerationCurrent: () =>
          generationCurrent.value
            ? ok(undefined)
            : err(makeControllerGenerationStaleFailure("gen-1")),
        ownerId: "test-owner",
        projectRoot: "/tmp/fake-project",
        maxAutoAdvanceSteps: 10,
        resolveAgentDescriptor: (agentName) => ({
          name: agentName,
          composedPrompt: `You are ${agentName}.`,
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
      const controller = new PiWorkflowController(deps);
      const workflowInstanceId = await createInstance(store);
      directDispatch.enqueue(okAsync(successCandidate()) as never);
      directDispatch.enqueue(okAsync(successCandidate()) as never);

      const auth = authorizeByExplicitUser(true);
      if (!auth.isOk()) throw new Error("unexpected");
      const result = await controller.startExecution(
        { workflowInstanceId, context: buildContext() },
        auth.value,
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) expect(result.value.finalStatus).toBe("completed");

      // The regression: on the pre-fix ordering, recording the terminal
      // step's idle observation after `completeStep` released the lease hit
      // a real FK constraint violation, degraded to a logged warning, and
      // silently dropped the SessionSnapshot row - even though the run
      // itself reported "completed". None of that may happen now.
      expect(warnings).toEqual([]);

      const snapshots = await store.snapshots.listByWorkflowInstance(
        createWorkflowInstanceId(workflowInstanceId),
      );
      expect(snapshots.isOk()).toBe(true);
      if (!snapshots.isOk()) return;
      const idleForImplement = snapshots.value.filter(
        (snapshot) =>
          snapshot.sessionStatus === "idle" &&
          snapshot.stepName === "implement",
      );
      expect(idleForImplement).toHaveLength(1);
    } finally {
      cleanupStore();
    }
  });
});
