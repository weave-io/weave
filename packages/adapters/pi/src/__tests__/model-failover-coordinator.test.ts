import { describe, expect, it } from "bun:test";
import {
  fingerprintPiAssistantMessage,
  type PiAssistantFingerprint,
} from "../model-failover-contract.js";
import {
  createPiModelFailoverCoordinator,
  isPiModelFailoverTransitionLegal,
  PI_MODEL_FAILOVER_STATES,
  PI_MODEL_FAILOVER_TRANSITIONS,
  PiModelFailoverCoordinator,
  transitionPiModelFailoverState,
} from "../model-failover-coordinator.js";
import type { PiModelInfo } from "../model-resolution.js";
import {
  RecordingFakePiHost,
  RecordingFakeTimerPort,
} from "./fakes/fake-pi-host.js";

const origin: PiModelInfo = {
  provider: "origin",
  id: "first",
  name: "First",
  contextWindow: 8,
};
const second: PiModelInfo = {
  provider: "fallback",
  id: "second",
  name: "Second",
  contextWindow: 16,
};
const third: PiModelInfo = {
  provider: "fallback",
  id: "third",
  name: "Third",
  contextWindow: 32,
};
const failedAssistant = {
  role: "assistant",
  id: "failed-assistant",
  stopReason: "error",
  content: [{ type: "text", text: "bounded partial output" }],
};

function fingerprint(): PiAssistantFingerprint {
  const result = fingerprintPiAssistantMessage(failedAssistant);
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

interface Harness {
  readonly host: RecordingFakePiHost;
  readonly timer: RecordingFakeTimerPort;
  readonly coordinator: PiModelFailoverCoordinator;
}

function harness(
  options: {
    readonly candidates?: readonly PiModelInfo[];
    readonly currentModel?: PiModelInfo;
    readonly onDecision?: (decision: unknown) => void;
    readonly onAppliedModel?: (event: unknown) => void;
  } = {},
): Harness {
  const host = new RecordingFakePiHost({
    currentModel: options.currentModel ?? origin,
    availableModels: [origin, second, third],
  });
  const timer = new RecordingFakeTimerPort();
  const coordinator = createPiModelFailoverCoordinator({
    host: host.api,
    context: host.createSessionContext(),
    generationId: "generation-1",
    nativeSessionId: "session-1",
    activationId: "activation-1",
    currentModel: options.currentModel ?? origin,
    candidates: options.candidates ?? [origin, second, third],
    timer,
    switchTimeoutMs: 100,
    markerTimeoutMs: 100,
    contextTimeoutMs: 100,
    getGenerationId: () => "generation-1",
    getNativeSessionId: () => "session-1",
    ...(options.onDecision === undefined
      ? {}
      : { onDecision: options.onDecision }),
    ...(options.onAppliedModel === undefined
      ? {}
      : { onAppliedModel: options.onAppliedModel }),
  });
  return { host, timer, coordinator };
}

const failure = (overrides: Record<string, unknown> = {}) => ({
  failureClass: "provider_unavailable" as const,
  failedModel: origin,
  fingerprint: fingerprint(),
  ...overrides,
});

async function start(h: Harness): Promise<void> {
  const result = await h.coordinator.handleFailure(failure());
  expect(result.isOk()).toBe(true);
}

function markerFromHost(h: Harness): Record<string, unknown> {
  const marker = h.host.sendMessageCalls.at(-1)?.message;
  expect(marker).toBeDefined();
  return marker as unknown as Record<string, unknown>;
}

function proveModel(h: Harness): void {
  expect(
    h.coordinator
      .onModelSelect({ model: second, source: "set" })
      ._unsafeUnwrap(),
  ).toBe(true);
}

function proveMarkerAndContext(h: Harness): void {
  const marker = markerFromHost(h);
  if (h.coordinator.state === "awaiting-marker-proof") {
    expect(
      h.coordinator
        .onMessageStart({ type: "message_start", message: marker })
        ._unsafeUnwrap(),
    ).toBe(true);
  }
  const repaired = h.coordinator.onContext([
    { role: "user", content: "task" },
    failedAssistant,
    marker,
    { role: "user", content: "follow-up" },
  ]);
  expect(repaired.isOk()).toBe(true);
  expect(repaired._unsafeUnwrap()).toEqual([
    { role: "user", content: "task" },
    { role: "user", content: "follow-up" },
  ]);
}

describe("Pi model-failover state table", () => {
  it("declares all explicit states and rejects illegal transitions", () => {
    expect(PI_MODEL_FAILOVER_STATES).toEqual([
      "armed",
      "switching",
      "awaiting-marker-proof",
      "awaiting-context-repair",
      "recovering",
      "manually-overridden",
      "exhausted",
      "terminal",
    ]);
    for (const from of PI_MODEL_FAILOVER_STATES) {
      for (const to of PI_MODEL_FAILOVER_STATES) {
        expect(isPiModelFailoverTransitionLegal(from, to)).toBe(
          PI_MODEL_FAILOVER_TRANSITIONS[from].includes(to),
        );
      }
    }
    expect(isPiModelFailoverTransitionLegal("armed", "switching")).toBe(true);
    expect(
      isPiModelFailoverTransitionLegal(
        "awaiting-marker-proof",
        "awaiting-context-repair",
      ),
    ).toBe(true);
    expect(isPiModelFailoverTransitionLegal("armed", "recovering")).toBe(false);
    expect(isPiModelFailoverTransitionLegal("recovering", "armed")).toBe(false);
    expect(
      transitionPiModelFailoverState("armed", "recovering")._unsafeUnwrapErr(),
    ).toEqual({
      type: "IllegalStateTransition",
      from: "armed",
      to: "recovering",
    });
    expect(Object.keys(PI_MODEL_FAILOVER_TRANSITIONS)).toHaveLength(8);
  });
});

describe("Pi model-failover coordinator", () => {
  it("arms the exact model expectation before switching and accepts either proof order", async () => {
    const h = harness();
    await start(h);
    expect(h.coordinator.state).toBe("switching");
    expect(h.host.setModelCalls[0]).toBe(second);
    expect(h.coordinator.snapshot().expectation).toMatchObject({
      candidate: { provider: second.provider, id: second.id },
      eventSeen: false,
      resultSeen: true,
    });

    proveModel(h);
    expect(h.coordinator.state).toBe("awaiting-marker-proof");
    expect(h.coordinator.snapshot().currentModel).toMatchObject({
      provider: second.provider,
      id: second.id,
    });
    expect(h.host.sendMessageCalls).toHaveLength(1);
    expect(h.host.sendMessageCalls[0]?.options).toEqual({ triggerTurn: true });
  });

  it("accepts model_select before setModel resolves", async () => {
    const h = harness();
    const deferred = h.host.deferNextSetModel();
    const pending = h.coordinator.handleFailure(failure());
    await deferred.called;
    expect(
      h.coordinator
        .onModelSelect({ model: second, source: "set" })
        ._unsafeUnwrap(),
    ).toBe(true);
    expect(h.coordinator.state).toBe("switching");
    deferred.settle(true);
    const result = await pending;
    expect(result.isOk()).toBe(true);
    expect(h.coordinator.state).toBe("awaiting-marker-proof");
  });

  it("skips false, catalog-missing, and auth-unavailable candidates without waiting for settlement", async () => {
    const h = harness({ candidates: [origin, second, third] });
    h.host.declineNextSetModel();
    await start(h);
    expect(h.host.setModelCalls.map((model) => model.id)).toEqual([
      second.id,
      third.id,
    ]);
    expect(h.coordinator.state).toBe("switching");

    const missing = harness({
      candidates: [origin, { provider: "missing", id: "nope" }],
    });
    await start(missing);
    expect(missing.host.setModelCalls).toHaveLength(0);
    expect(missing.coordinator.state).toBe("exhausted");
    expect(missing.coordinator.terminalDecision?.kind).toBe("exhausted");

    const auth = harness({ candidates: [origin, second] });
    const authCoordinator = new PiModelFailoverCoordinator({
      host: auth.host.api,
      context: auth.host.createSessionContext(),
      generationId: "generation-1",
      nativeSessionId: "session-1",
      activationId: "activation-1",
      currentModel: origin,
      candidates: [origin, second],
      timer: auth.timer,
      isAuthenticated: () => false,
    });
    const result = await authCoordinator.handleFailure(failure());
    expect(result.isOk()).toBe(true);
    expect(auth.host.setModelCalls).toHaveLength(0);
    expect(authCoordinator.state).toBe("exhausted");
  });

  it.each([
    ["throw", (h: Harness) => h.host.poisonSetModel(), "switch-call-failed"],
    ["reject", (h: Harness) => h.host.rejectSetModel(), "switch-call-failed"],
    [
      "indeterminate",
      (h: Harness) => h.host.indeterminateSetModel(),
      "switch-indeterminate",
    ],
  ] as const)("terminates fail-closed on setModel %s", async (_label, arrange, reason) => {
    const h = harness();
    arrange(h);
    await start(h);
    expect(h.coordinator.state).toBe("terminal");
    expect(h.coordinator.terminalDecision).toMatchObject({
      kind: "failed",
      reason,
    });
  });

  it("fails closed when a matching model event is paired with setModel(false)", async () => {
    const h = harness();
    const deferred = h.host.deferNextSetModel();
    const pending = h.coordinator.handleFailure(failure());
    await deferred.called;
    expect(h.coordinator.onModelSelect({ model: second })._unsafeUnwrap()).toBe(
      true,
    );
    deferred.settle(false);
    await pending;
    expect(h.coordinator.state).toBe("manually-overridden");
    expect(h.coordinator.terminalDecision).toMatchObject({
      kind: "failed",
      reason: "manual-override",
    });
  });

  it("terminates a pending setModel on the bounded switch timeout", async () => {
    const h = harness();
    const deferred = h.host.deferNextSetModel();
    const pending = h.coordinator.handleFailure(failure());
    await deferred.called;
    h.timer.fireNext();
    const result = await pending;
    expect(result.isOk()).toBe(true);
    expect(h.coordinator.terminalDecision).toMatchObject({
      kind: "failed",
      reason: "switch-timeout",
    });
    deferred.settle(true);
    await Promise.resolve();
    expect(h.coordinator.terminalDecision?.kind).toBe("failed");
  });

  it("requires exact model proof and latches manual override for unmatched, duplicate, and delayed events", async () => {
    const h = harness();
    await start(h);
    expect(h.coordinator.onModelSelect({ model: third }).isErr()).toBe(true);
    expect(h.coordinator.state).toBe("manually-overridden");
    expect(h.coordinator.snapshot().manualOverrideLatched).toBe(true);
    expect(h.coordinator.terminalDecision).toMatchObject({
      kind: "failed",
      reason: "manual-override",
    });

    const duplicate = harness();
    await start(duplicate);
    proveModel(duplicate);
    expect(duplicate.coordinator.onModelSelect({ model: second }).isErr()).toBe(
      true,
    );
    expect(duplicate.coordinator.state).toBe("manually-overridden");

    const delayed = harness();
    await start(delayed);
    delayed.timer.fireNext();
    expect(delayed.coordinator.state).toBe("terminal");
    expect(delayed.coordinator.onModelSelect({ model: second }).isErr()).toBe(
      true,
    );
    expect(delayed.coordinator.snapshot().manualOverrideLatched).toBe(true);
  });

  it("proves marker dispatch only from exact message_start and repairs exact context", async () => {
    const h = harness();
    await start(h);
    proveModel(h);
    const marker = markerFromHost(h);
    expect(
      h.coordinator.onMessageStart({ type: "turn_start" })._unsafeUnwrap(),
    ).toBe(false);
    expect(h.coordinator.state).toBe("awaiting-marker-proof");
    expect(
      h.coordinator
        .onMessageStart({ type: "message_start", message: marker })
        ._unsafeUnwrap(),
    ).toBe(true);
    expect(h.coordinator.state).toBe("awaiting-context-repair");
    proveMarkerAndContext(h);
    expect(h.coordinator.state).toBe("recovering");
    expect(
      h.coordinator.handleAgentSettled({ status: "success" }),
    ).toBeDefined();
    await h.coordinator.handleAgentSettled({ status: "success" });
    expect(h.coordinator.state).toBe("terminal");
    expect(h.coordinator.terminalDecision?.kind).toBe("success");
  });

  it("fails closed on marker and context timeouts", async () => {
    const markerTimeout = harness();
    await start(markerTimeout);
    proveModel(markerTimeout);
    markerTimeout.timer.fireNext();
    expect(markerTimeout.coordinator.terminalDecision).toMatchObject({
      kind: "failed",
      reason: "marker-timeout",
    });

    const contextTimeout = harness();
    await start(contextTimeout);
    proveModel(contextTimeout);
    const marker = markerFromHost(contextTimeout);
    contextTimeout.coordinator.onMessageStart({
      type: "message_start",
      message: marker,
    });
    contextTimeout.timer.fireNext();
    expect(contextTimeout.coordinator.terminalDecision).toMatchObject({
      kind: "failed",
      reason: "context-timeout",
    });
    expect(
      contextTimeout.coordinator.onContext([failedAssistant, marker]).isErr(),
    ).toBe(true);
  });

  it("reports applied truth but fails closed when post-proof public preconditions race", async () => {
    const applied: unknown[] = [];
    const h = harness({ onAppliedModel: (event) => applied.push(event) });
    await start(h);
    h.host.setIdle(false);
    proveModel(h);
    expect(applied).toHaveLength(1);
    expect(h.coordinator.currentModel).toEqual({
      provider: second.provider,
      id: second.id,
    });
    expect(h.coordinator.terminalDecision).toMatchObject({
      kind: "failed",
      reason: "operation-failed",
    });
    expect(h.coordinator.state).toBe("terminal");
  });

  it("emits applied truth before a later recovery failure and advances without revisiting", async () => {
    const applied: unknown[] = [];
    const h = harness({ onDecision: () => undefined });
    const coordinator = new PiModelFailoverCoordinator({
      host: h.host.api,
      context: h.host.createSessionContext(),
      generationId: "generation-1",
      nativeSessionId: "session-1",
      activationId: "activation-1",
      currentModel: origin,
      candidates: [origin, second, third],
      timer: h.timer,
      onAppliedModel: (event) => applied.push(event),
    });
    await coordinator.handleFailure(failure());
    coordinator.onModelSelect({ model: second });
    const marker = h.host.sendMessageCalls.at(-1)?.message as unknown as Record<
      string,
      unknown
    >;
    coordinator.onMessageStart({ type: "message_start", message: marker });
    coordinator.onContext([failedAssistant, marker]);
    expect(coordinator.state).toBe("recovering");
    expect(applied).toHaveLength(1);

    const later = {
      failureClass: "timeout" as const,
      failedModel: second,
      fingerprint: fingerprint(),
    };
    expect(coordinator.observeLaterFailure(later).isOk()).toBe(true);
    await coordinator.handleAgentSettled({ status: "success" });
    expect(h.host.setModelCalls.map((model) => model.id)).toEqual([
      second.id,
      third.id,
    ]);
    expect(coordinator.state).toBe("switching");
    coordinator.onModelSelect({ model: third });
    expect(coordinator.currentModel?.id).toBe(third.id);
  });

  it("settles exhaustion and success exactly once, including delayed events", async () => {
    const decisions: unknown[] = [];
    const h = harness({
      candidates: [origin, second],
      onDecision: (decision) => decisions.push(decision),
    });
    h.host.declineNextSetModel();
    await start(h);
    expect(h.coordinator.state).toBe("exhausted");
    await h.coordinator.handleAgentSettled({ status: "success" });
    h.timer.fireAll();
    expect(decisions).toHaveLength(1);

    const successDecisions: unknown[] = [];
    const success = harness({
      onDecision: (decision) => successDecisions.push(decision),
    });
    await success.coordinator.handleAgentSettled({ status: "success" });
    await success.coordinator.handleAgentSettled({ status: "success" });
    expect(success.coordinator.state).toBe("terminal");
    expect(successDecisions).toHaveLength(1);
  });

  it("keeps stale callbacks out of an explicitly activated scope", async () => {
    const h = harness();
    const deferred = h.host.deferNextSetModel();
    const pending = h.coordinator.handleFailure(failure());
    await deferred.called;
    h.coordinator.explicitActivate({
      generationId: "generation-2",
      nativeSessionId: "session-2",
      activationId: "activation-2",
      candidates: [origin, third],
      currentModel: origin,
    });
    deferred.settle(true);
    await pending;
    expect(h.coordinator.state).toBe("armed");
    expect(h.coordinator.snapshot().scope.generationId).toBe("generation-2");
    expect(h.coordinator.snapshot().cursorAdvanced).toBe(0);
    expect(h.coordinator.terminalDecision).toBeUndefined();
  });

  it("stops before switching when the public cancellation probe is active", async () => {
    const h = harness();
    const coordinator = new PiModelFailoverCoordinator({
      host: h.host.api,
      context: h.host.createSessionContext(),
      generationId: "generation-1",
      nativeSessionId: "session-1",
      activationId: "activation-1",
      currentModel: origin,
      candidates: [origin, second],
      timer: h.timer,
      isCancelled: () => true,
    });
    await coordinator.handleFailure(failure());
    expect(h.host.setModelCalls).toHaveLength(0);
    expect(coordinator.terminalDecision).toMatchObject({
      kind: "failed",
      reason: "cancelled",
    });
  });

  it("distinguishes authenticated cancellation from local cancellation", async () => {
    const local = harness();
    await start(local);
    local.coordinator.cancelRecovery();
    expect(local.coordinator.terminalDecision).toMatchObject({
      kind: "failed",
      reason: "cancelled",
    });

    const parent = harness();
    await start(parent);
    parent.coordinator.cancel({ authority: "authenticated-parent" });
    expect(parent.coordinator.terminalDecision).toMatchObject({
      kind: "cancelled",
      authority: "authenticated-parent",
    });
  });

  it("publishes retained failure once for reset, reload, and shutdown", async () => {
    for (const method of ["reset", "reload", "shutdown"] as const) {
      const decisions: unknown[] = [];
      const h = harness({ onDecision: (decision) => decisions.push(decision) });
      await start(h);
      h.coordinator[method]();
      h.coordinator[method]();
      expect(decisions).toHaveLength(1);
    }
  });

  it("does not treat a rejected fire-and-forget send as dispatch proof", async () => {
    const h = harness();
    h.host.rejectSendMessage();
    await start(h);
    proveModel(h);
    await Promise.resolve();
    expect(h.coordinator.state).toBe("awaiting-marker-proof");
    expect(h.coordinator.terminalDecision).toBeUndefined();
  });
});
