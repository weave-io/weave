import { describe, expect, it } from "bun:test";
import {
  classifyPiMessageEndFailure,
  fingerprintPiAssistantMessage,
  type PiAssistantFingerprint,
} from "../model-failover-contract.js";
import {
  createPiModelFailoverCoordinator,
  type PiModelFailoverCoordinator,
  type PiModelFailoverTerminalDecision,
} from "../model-failover-coordinator.js";
import type { PiModelInfo } from "../model-resolution.js";
import {
  RecordingFakePiHost,
  RecordingFakeTimerPort,
} from "./fakes/fake-pi-host.js";

const origin: PiModelInfo = {
  provider: "origin-provider",
  id: "origin-model",
  name: "Origin",
};
const fallback: PiModelInfo = {
  provider: "fallback-provider",
  id: "fallback-model",
  name: "Fallback",
};
const lastFallback: PiModelInfo = {
  provider: "last-provider",
  id: "last-model",
  name: "Last fallback",
};

function failedAssistant(
  id: string,
  status: number,
): {
  readonly role: "assistant";
  readonly id: string;
  readonly stopReason: "error";
  readonly status: number;
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
} {
  return {
    role: "assistant",
    id,
    stopReason: "error",
    status,
    content: [{ type: "text", text: `partial output for ${id}` }],
  };
}

function successAssistant(id: string): {
  readonly role: "assistant";
  readonly id: string;
  readonly stopReason: "stop";
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
} {
  return {
    role: "assistant",
    id,
    stopReason: "stop",
    content: [{ type: "text", text: `successful output for ${id}` }],
  };
}

function fingerprint(message: unknown): PiAssistantFingerprint {
  const result = fingerprintPiAssistantMessage(message);
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

function contextMessages(event: unknown): readonly unknown[] | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const payload = event as {
    readonly type?: unknown;
    readonly messages?: unknown;
  };
  return payload.type === "context" && Array.isArray(payload.messages)
    ? payload.messages
    : undefined;
}

interface LifecycleHarness {
  readonly host: RecordingFakePiHost;
  readonly timer: RecordingFakeTimerPort;
  readonly coordinator: PiModelFailoverCoordinator;
  readonly decisions: PiModelFailoverTerminalDecision[];
  readonly recoveryConfirmed: number[];
}

function createLifecycleHarness(
  candidates: readonly PiModelInfo[] = [origin, fallback, lastFallback],
): LifecycleHarness {
  const host = new RecordingFakePiHost({
    currentModel: origin,
    availableModels: candidates,
  });
  const timer = new RecordingFakeTimerPort();
  const decisions: PiModelFailoverTerminalDecision[] = [];
  const recoveryConfirmed: number[] = [];
  const coordinator = createPiModelFailoverCoordinator({
    host: host.api,
    generationId: "generation-lifecycle-1",
    nativeSessionId: "native-session-lifecycle-1",
    activationId: "activation-lifecycle-1",
    currentModel: origin,
    candidates,
    context: host.createSessionContext(),
    timer,
    switchTimeoutMs: 100,
    markerTimeoutMs: 100,
    contextTimeoutMs: 100,
    getGenerationId: () => "generation-lifecycle-1",
    getNativeSessionId: () => "native-session-lifecycle-1",
    onTerminal: (decision) => decisions.push(decision),
    onRecoveryConfirmed: () => recoveryConfirmed.push(1),
  });

  // Exercise the public event order instead of calling coordinator methods
  // directly. This fake intentionally models Pi's payloadless settlement and
  // replacement-returning context boundaries.
  host.api.on("message_end", (event) => {
    const classification = classifyPiMessageEndFailure(event);
    if (
      classification === undefined ||
      typeof event !== "object" ||
      event === null
    )
      return undefined;
    const message = (event as { readonly message?: unknown }).message;
    if (message === undefined) return undefined;
    const input = {
      failureClass: classification.failureClass,
      failedModel: host.getCurrentModel() ?? origin,
      fingerprint: fingerprint(message),
    } as const;
    const result =
      coordinator.state === "recovering"
        ? coordinator.observeLaterFailure(input)
        : coordinator.observeFailure(input);
    return result.isOk() ? undefined : undefined;
  });
  host.api.on("agent_settled", () => coordinator.handleAgentSettled(undefined));
  host.api.on("model_select", (event) => coordinator.onModelSelect(event));
  host.api.on("message_start", (event) => coordinator.onMessageStart(event));
  host.api.on("context", (event) => {
    const messages = contextMessages(event);
    if (messages === undefined) return undefined;
    const repaired = coordinator.onContext(messages);
    return repaired.match(
      (value) => (value === messages ? undefined : { messages: value }),
      () => undefined,
    );
  });

  return { host, timer, coordinator, decisions, recoveryConfirmed };
}

async function emitFailedMessage(
  harness: LifecycleHarness,
  message: ReturnType<typeof failedAssistant>,
): Promise<void> {
  harness.host.appendDurableHistory(message);
  await harness.host.triggerEvent("message_end", {
    type: "message_end",
    message,
  });
}

async function completeModelSwitchAndContext(
  harness: LifecycleHarness,
  failed: ReturnType<typeof failedAssistant>,
  candidate: PiModelInfo,
): Promise<Record<string, unknown>> {
  const deferred = harness.host.deferNextSetModel();
  const settlement = harness.host.triggerEvent("agent_settled", {
    type: "agent_settled",
  });
  await deferred.called;

  // Both model proofs are required. This order proves that the native
  // model_select may arrive while the asynchronous setModel is unresolved.
  await harness.host.triggerModelSelect(candidate, "set");
  deferred.settle(true);
  await settlement;

  const sent = harness.host.sendMessageCalls.at(-1)?.message;
  expect(sent).toMatchObject({
    role: "custom",
    customType: "weave.model-fallback.recovery-marker",
    display: false,
  });
  if (sent === undefined)
    throw new Error("test setup: recovery marker missing");
  const marker = sent as unknown as Record<string, unknown>;
  harness.host.appendSentMessageToDurableHistory();

  await harness.host.triggerEvent("message_start", {
    type: "message_start",
    message: marker,
  });
  const providerContext = await harness.host.triggerContext([failed, marker]);
  expect(providerContext).toEqual([]);
  return marker;
}

async function emitSuccessfulSettlement(
  harness: LifecycleHarness,
  message: ReturnType<typeof successAssistant>,
): Promise<void> {
  harness.host.appendDurableHistory(message);
  await harness.host.triggerEvent("message_end", {
    type: "message_end",
    message,
  });
  await harness.host.triggerEvent("agent_settled", {
    type: "agent_settled",
  });
}

describe("Pi model fallback lifecycle integration", () => {
  it("advances later fallback failures in order and settles a successful chain exactly once", async () => {
    const harness = createLifecycleHarness();
    const firstFailure = failedAssistant("failed-origin", 503);
    const secondFailure = failedAssistant("failed-fallback", 429);
    const finalSuccess = successAssistant("successful-last-fallback");

    await emitFailedMessage(harness, firstFailure);
    expect(harness.coordinator.state).toBe("armed");
    expect(harness.decisions).toHaveLength(0);

    const firstMarker = await completeModelSwitchAndContext(
      harness,
      firstFailure,
      fallback,
    );
    expect(firstMarker.customType).toBe("weave.model-fallback.recovery-marker");
    expect(harness.coordinator.state).toBe("recovering");
    expect(harness.recoveryConfirmed).toHaveLength(1);

    // The second low-level run fails. The coordinator retains this new
    // bounded fingerprint and advances to the next frozen candidate, never
    // revisiting the origin or the already-applied fallback.
    await emitFailedMessage(harness, secondFailure);
    const secondMarker = await completeModelSwitchAndContext(
      harness,
      secondFailure,
      lastFallback,
    );
    expect(secondMarker.customType).toBe(
      "weave.model-fallback.recovery-marker",
    );
    expect(harness.host.setModelCalls.map((model) => model.id)).toEqual([
      fallback.id,
      lastFallback.id,
    ]);
    expect(harness.recoveryConfirmed).toHaveLength(2);

    await emitSuccessfulSettlement(harness, finalSuccess);
    expect(harness.coordinator.state).toBe("terminal");
    expect(harness.decisions).toHaveLength(1);
    expect(harness.decisions[0]?.kind).toBe("success");

    // Delayed duplicate Pi events cannot reopen a terminal recovery epoch or
    // publish another visible/child settlement.
    await harness.host.triggerEvent("message_end", {
      type: "message_end",
      message: finalSuccess,
    });
    await harness.host.triggerEvent("agent_settled", {
      type: "agent_settled",
    });
    expect(harness.decisions).toHaveLength(1);
    expect(harness.host.durableHistory).toEqual([
      firstFailure,
      firstMarker,
      secondFailure,
      secondMarker,
      finalSuccess,
    ]);
  });

  it("exhausts after a later fallback error without revisiting a candidate or settling twice", async () => {
    const harness = createLifecycleHarness([origin, fallback]);
    const firstFailure = failedAssistant("failed-origin-exhaustion", 503);
    const laterFailure = failedAssistant("failed-fallback-exhaustion", 503);

    await emitFailedMessage(harness, firstFailure);
    await completeModelSwitchAndContext(harness, firstFailure, fallback);
    expect(harness.coordinator.state).toBe("recovering");

    await emitFailedMessage(harness, laterFailure);
    await harness.host.triggerEvent("agent_settled", {
      type: "agent_settled",
    });

    expect(harness.host.setModelCalls.map((model) => model.id)).toEqual([
      fallback.id,
    ]);
    expect(harness.host.sendMessageCalls).toHaveLength(1);
    expect(harness.coordinator.state).toBe("exhausted");
    expect(harness.coordinator.terminalDecision?.kind).toBe("exhausted");
    expect(harness.decisions).toHaveLength(1);

    // A late success-shaped event cannot turn bounded exhaustion into success.
    await harness.host.triggerEvent("message_end", {
      type: "message_end",
      message: successAssistant("late-success-after-exhaustion"),
    });
    await harness.host.triggerEvent("agent_settled", {
      type: "agent_settled",
    });
    expect(harness.decisions).toHaveLength(1);
  });

  it.each([
    ["switch timeout", "switch-timeout" as const],
    ["marker timeout", "marker-timeout" as const],
    ["context timeout", "context-timeout" as const],
  ] as const)("settles exactly once across a %s and late lifecycle events", async (label, reason) => {
    const harness = createLifecycleHarness([origin, fallback]);
    const failure = failedAssistant(`race-${label}`, 503);
    await emitFailedMessage(harness, failure);

    const deferred = harness.host.deferNextSetModel();
    const settlement = harness.host.triggerEvent("agent_settled", {
      type: "agent_settled",
    });
    await deferred.called;
    let marker: unknown;

    if (reason === "switch-timeout") {
      harness.timer.fireNext();
      const decision = harness.coordinator.terminalDecision;
      expect(decision?.kind).toBe("failed");
      if (decision?.kind !== "failed") {
        throw new Error("test setup: switch timeout did not fail closed");
      }
      expect(decision.reason).toBe(reason);
      deferred.settle(true);
      await settlement;
    } else {
      await harness.host.triggerModelSelect(fallback, "set");
      deferred.settle(true);
      await settlement;
      marker = harness.host.sendMessageCalls.at(-1)?.message;
      if (marker === undefined) throw new Error("test setup: marker missing");
      harness.host.appendSentMessageToDurableHistory();
      if (reason === "marker-timeout") {
        // Fire the marker timer before Pi proves message_start.
        harness.timer.fireNext();
      } else {
        await harness.host.triggerEvent("message_start", {
          type: "message_start",
          message: marker,
        });
        harness.timer.fireNext();
      }
      const decision = harness.coordinator.terminalDecision;
      expect(decision?.kind).toBe("failed");
      if (decision?.kind !== "failed") {
        throw new Error("test setup: recovery timeout did not fail closed");
      }
      expect(decision.reason).toBe(reason);
    }

    // Every event that arrives after a timeout is ignored. In particular,
    // late marker/context delivery cannot create a second settlement.
    if (marker !== undefined) {
      await harness.host.triggerEvent("message_start", {
        type: "message_start",
        message: marker,
      });
      await harness.host.triggerContext([failure, marker]);
    } else {
      await harness.host.triggerContext([failure]);
    }
    await harness.host.triggerEvent("agent_settled", {
      type: "agent_settled",
    });
    expect(harness.decisions).toHaveLength(1);
    const terminal = harness.coordinator.terminalDecision;
    expect(terminal?.kind).toBe("failed");
    if (terminal?.kind !== "failed") {
      throw new Error("test setup: late lifecycle changed terminal result");
    }
    expect(terminal.reason).toBe(reason);
  });
});
