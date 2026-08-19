import { describe, expect, it } from "bun:test";
import {
  createPiModelFailoverMarker,
  fingerprintPiAssistantMessage,
  type PiAssistantFingerprint,
} from "../model-failover-contract.js";
import {
  createPiModelFailoverCoordinator,
  type PiModelFailoverCoordinator,
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
  contextWindow: 8_000,
};
const fallback: PiModelInfo = {
  provider: "fallback-provider",
  id: "fallback-model",
  name: "Fallback",
  contextWindow: 16_000,
};
const lastFallback: PiModelInfo = {
  provider: "last-provider",
  id: "last-model",
  name: "Last fallback",
  contextWindow: 32_000,
};

const failedAssistant = {
  role: "assistant",
  id: "failed-partial-assistant",
  stopReason: "error",
  status: 503,
  content: [{ type: "text", text: "partial failed output" }],
} as const;

function failedFingerprint(): PiAssistantFingerprint {
  const result = fingerprintPiAssistantMessage(failedAssistant);
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

interface ContextHarness {
  readonly host: RecordingFakePiHost;
  readonly timer: RecordingFakeTimerPort;
  readonly coordinator: PiModelFailoverCoordinator;
}

function createContextHarness(
  candidates: readonly PiModelInfo[] = [origin, fallback, lastFallback],
): ContextHarness {
  const host = new RecordingFakePiHost({
    currentModel: origin,
    availableModels: candidates,
  });
  const timer = new RecordingFakeTimerPort();
  const coordinator = createPiModelFailoverCoordinator({
    host: host.api,
    generationId: "generation-context-1",
    nativeSessionId: "native-session-context-1",
    activationId: "activation-context-1",
    currentModel: origin,
    candidates,
    context: host.createSessionContext(),
    timer,
    switchTimeoutMs: 100,
    markerTimeoutMs: 100,
    contextTimeoutMs: 100,
    getGenerationId: () => "generation-context-1",
    getNativeSessionId: () => "native-session-context-1",
    onTerminal: () => undefined,
  });

  // Register the same public lifecycle boundary that the adapter uses. The
  // later context handler below is intentionally a trusted composition
  // partner, not a hostile-extension isolation test.
  host.api.on("message_end", (event) => {
    if (typeof event !== "object" || event === null || !("message" in event)) {
      return undefined;
    }
    const message = (event as { readonly message?: unknown }).message;
    if (message !== failedAssistant) return undefined;
    return coordinator.observeFailure({
      failureClass: "provider_unavailable",
      failedModel: origin,
      fingerprint: failedFingerprint(),
    });
  });
  host.api.on("agent_settled", () => coordinator.handleAgentSettled(undefined));
  host.api.on("model_select", (event) => coordinator.onModelSelect(event));
  host.api.on("message_start", (event) => coordinator.onMessageStart(event));
  host.api.on("context", (messages) => {
    if (!Array.isArray(messages)) return undefined;
    const repaired = coordinator.onContext(messages);
    return repaired.match(
      (value) => (value === messages ? undefined : value),
      () => undefined,
    );
  });

  return { host, timer, coordinator };
}

async function beginFallback(
  harness: ContextHarness,
): Promise<{ readonly marker: Record<string, unknown> }> {
  const deferred = harness.host.deferNextSetModel();
  const operation = harness.coordinator.handleFailure({
    failureClass: "provider_unavailable",
    failedModel: origin,
    fingerprint: failedFingerprint(),
  });
  await deferred.called;

  // Pi may report its model event before the asynchronous setModel result.
  await harness.host.triggerModelSelect(fallback, "set");
  deferred.settle(true);
  const result = await operation;
  expect(result.isOk()).toBe(true);
  expect(harness.coordinator.state).toBe("awaiting-marker-proof");

  const marker = harness.host.sendMessageCalls.at(-1)?.message;
  expect(marker).toBeDefined();
  return { marker: marker as unknown as Record<string, unknown> };
}

async function admitMarker(
  harness: ContextHarness,
  marker: Record<string, unknown>,
): Promise<void> {
  await harness.host.triggerEvent("message_start", {
    type: "message_start",
    message: marker,
  });
  expect(harness.coordinator.state).toBe("awaiting-context-repair");
}

function validHistory(marker: unknown): readonly unknown[] {
  const task = {
    role: "user",
    id: "task-1",
    content: "Rewrite the retry coordinator.",
  };
  const user = {
    role: "user",
    id: "user-1",
    content: "Keep the provider history intact.",
  };
  const toolCall = {
    role: "assistant",
    id: "tool-call-assistant",
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        id: "call-1",
        name: "read_file",
        arguments: { path: "src/retry.ts" },
      },
    ],
  };
  const toolResult = {
    role: "toolResult",
    toolCallId: "call-1",
    content: [{ type: "text", text: "retry.ts contents" }],
  };
  const steering = {
    role: "user",
    id: "steering-1",
    content: "Use the public Pi API only.",
    delivery: "steer",
  };
  const followUp = {
    role: "user",
    id: "follow-up-1",
    content: "Also preserve queued work.",
    delivery: "followUp",
  };
  const unrelatedCustom = {
    role: "custom",
    customType: "trusted-extension.note",
    content: "keep this unrelated custom entry",
    display: false,
    details: { revision: 1 },
  };
  const queuedRealWork = {
    role: "user",
    id: "queued-user-1",
    content: "Run the tests after the retry change.",
    queued: true,
  };
  return [
    task,
    user,
    toolCall,
    toolResult,
    steering,
    followUp,
    unrelatedCustom,
    failedAssistant,
    marker,
    queuedRealWork,
  ];
}

function malformedMessages(
  name: string,
  marker: Record<string, unknown>,
): readonly unknown[] {
  switch (name) {
    case "missing marker":
      return [failedAssistant];
    case "duplicate token":
      return [failedAssistant, marker, { ...marker }];
    case "duplicate marker":
      return [failedAssistant, marker, marker];
    case "wrong token":
      return [
        failedAssistant,
        createPiModelFailoverMarker(
          "550e8400-e29b-41d4-a716-446655440001",
        )._unsafeUnwrap(),
      ];
    case "wrong custom type":
      return [failedAssistant, { ...marker, customType: "other-extension" }];
    case "wrong role":
      return [failedAssistant, { ...marker, role: "user" }];
    case "missing failed assistant":
      return [{ role: "user", content: "not the failed assistant" }, marker];
    case "nonadjacent failed assistant":
      return [
        failedAssistant,
        { role: "user", content: "interposed real work" },
        marker,
      ];
    case "fingerprint mismatch":
      return [{ ...failedAssistant, id: "different-failed-assistant" }, marker];
    default:
      throw new Error(`unknown malformed context case: ${name}`);
  }
}

describe("Pi model fallback provider-context integration", () => {
  it("runs the exact public lifecycle and preserves real context at provider conversion", async () => {
    const harness = createContextHarness();
    const trace: string[] = [];
    const trustedContextInputs: Array<readonly unknown[]> = [];

    // This is a later trusted handler. The test proves composition ordering,
    // not hostile-extension isolation: a full-access extension is outside the
    // adapter's trust boundary.
    harness.host.api.on("context", (messages) => {
      trustedContextInputs.push(messages as readonly unknown[]);
      return undefined;
    });

    trace.push("message_end:failed");
    const failedMessageEnd = harness.host.triggerEvent("message_end", {
      type: "message_end",
      message: failedAssistant,
    });
    await failedMessageEnd;
    harness.host.appendDurableHistory(failedAssistant);
    const deferred = harness.host.deferNextSetModel();

    trace.push("agent_settled:payloadless");
    // This event is intentionally payloadless. The failure remains retained
    // while Pi's native recovery has ended and Weave begins its own attempt.
    const settlement = harness.host.triggerEvent("agent_settled", {
      type: "agent_settled",
    });
    await deferred.called;
    expect(harness.host.sendMessageCalls).toHaveLength(0);

    trace.push("model_select:async");
    await harness.host.triggerModelSelect(fallback, "set");
    deferred.settle(true);
    await settlement;

    const marker = harness.host.sendMessageCalls.at(-1)?.message;
    expect(marker).toMatchObject({
      role: "custom",
      customType: "weave.model-fallback.recovery-marker",
      display: false,
    });
    trace.push("marker_send:hidden");
    if (marker === undefined) throw new Error("test setup: marker missing");
    harness.host.appendSentMessageToDurableHistory();

    trace.push("message_start:exact-marker");
    await admitMarker(harness, marker as unknown as Record<string, unknown>);

    const providerInput = validHistory(marker);
    trace.push("context:replacement");
    const providerContext = await harness.host.triggerContext(providerInput);
    trace.push("provider_conversion:capture");

    const expectedProviderContext = providerInput.filter(
      (entry) => entry !== failedAssistant && entry !== marker,
    );
    expect(providerContext).toEqual(expectedProviderContext);
    expect(providerContext).toHaveLength(providerInput.length - 2);
    expect(providerContext).not.toContain(failedAssistant);
    expect(providerContext).not.toContain(marker);
    expect(providerContext).toContainEqual({
      role: "user",
      id: "task-1",
      content: "Rewrite the retry coordinator.",
    });
    expect(providerContext).toContainEqual({
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: "retry.ts contents" }],
    });
    expect(providerContext).toContainEqual(
      expect.objectContaining({ id: "steering-1", delivery: "steer" }),
    );
    expect(providerContext).toContainEqual(
      expect.objectContaining({ id: "follow-up-1", delivery: "followUp" }),
    );
    expect(providerContext).toContainEqual({
      role: "custom",
      customType: "trusted-extension.note",
      content: "keep this unrelated custom entry",
      display: false,
      details: { revision: 1 },
    });
    expect(providerContext).toContainEqual(
      expect.objectContaining({ id: "queued-user-1", queued: true }),
    );

    // The later trusted handler receives Weave's already-filtered list.
    expect(trustedContextInputs).toHaveLength(1);
    expect(trustedContextInputs[0]).toEqual(expectedProviderContext);

    // Pi's durable native history remains complete. Only the provider-bound
    // clone is replaced; the fake records both surfaces independently.
    harness.host.durableHistory.length = 0;
    for (const entry of providerInput) {
      harness.host.appendDurableHistory(entry);
    }
    harness.host.captureProviderConversion(providerContext);
    expect(harness.host.providerConversions).toEqual([
      {
        durableHistory: providerInput,
        providerMessages: expectedProviderContext,
      },
    ]);

    // No provider-level user message represents the hidden marker. The marker
    // is a durable custom entry only, and the provider list contains no marker
    // content or marker-shaped user role.
    expect(
      providerContext.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { readonly role?: unknown }).role === "user" &&
          (entry as { readonly content?: unknown }).content === marker.content,
      ),
    ).toBe(false);

    const fallbackAssistant = {
      role: "assistant",
      id: "successful-fallback-assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "fallback answer" }],
    } as const;
    trace.push("message_end:fallback-success");
    await harness.host.triggerEvent("message_end", {
      type: "message_end",
      message: fallbackAssistant,
    });
    harness.host.appendDurableHistory(fallbackAssistant);
    trace.push("agent_settled:fallback-success");
    await harness.host.triggerEvent("agent_settled", {
      type: "agent_settled",
    });
    expect(harness.coordinator.state).toBe("terminal");

    expect(trace).toEqual([
      "message_end:failed",
      "agent_settled:payloadless",
      "model_select:async",
      "marker_send:hidden",
      "message_start:exact-marker",
      "context:replacement",
      "provider_conversion:capture",
      "message_end:fallback-success",
      "agent_settled:fallback-success",
    ]);
    expect(harness.host.durableHistory).toEqual([
      ...providerInput,
      fallbackAssistant,
    ]);
    expect(harness.host.durableHistory).toContain(failedAssistant);
    expect(harness.host.durableHistory).toContain(marker);
    expect(harness.host.durableHistory.at(-1)).toBe(fallbackAssistant);

    // A delayed low-level settlement must not publish a second terminal result.
    await harness.host.triggerEvent("agent_settled", {
      type: "agent_settled",
    });
    expect(harness.coordinator.terminalDecision?.kind).toBe("success");
  });

  it("fails closed for the complete malformed marker and adjacency matrix", async () => {
    const cases = [
      "missing marker",
      "duplicate token",
      "duplicate marker",
      "wrong token",
      "wrong custom type",
      "wrong role",
      "missing failed assistant",
      "nonadjacent failed assistant",
      "fingerprint mismatch",
    ] as const;

    for (const name of cases) {
      const harness = createContextHarness();
      const decisions: unknown[] = [];
      // A fresh coordinator callback is not replaceable, so use the public
      // terminal decision after each malformed context instead of retaining
      // provider data in a test callback.
      const operation = await beginFallback(harness);
      await admitMarker(harness, operation.marker);
      const input = malformedMessages(name, operation.marker);
      const result = await harness.host.triggerContext(input);

      expect(result).toEqual(input);
      expect(harness.coordinator.state).toBe("terminal");
      const decision = harness.coordinator.terminalDecision;
      expect(decision?.kind).toBe("failed");
      if (decision?.kind !== "failed") {
        throw new Error("test setup: malformed context did not fail closed");
      }
      expect(decision.reason).toBe("context-repair-failed");
      decisions.push(decision);

      // A late duplicate context cannot reopen a closed recovery epoch.
      expect(await harness.host.triggerContext(input)).toEqual(input);
      expect(decisions).toHaveLength(1);
    }
  });

  it("keeps queued real input intact and stops before marker dispatch when a pending-input race appears", async () => {
    const harness = createContextHarness([origin, fallback]);
    const queued = {
      role: "user",
      id: "queued-race-user",
      content: "This real message arrived during recovery.",
    };
    const context = [
      { role: "user", id: "task", content: "task" },
      failedAssistant,
      queued,
    ];
    harness.host.setPendingMessages(true);

    const result = await harness.coordinator.handleFailure({
      failureClass: "provider_unavailable",
      failedModel: origin,
      fingerprint: failedFingerprint(),
    });
    expect(result.isOk()).toBe(true);
    expect(harness.host.setModelCalls).toHaveLength(0);
    expect(harness.host.sendMessageCalls).toHaveLength(0);
    expect(harness.coordinator.terminalDecision?.kind).toBe("exhausted");

    // No marker was admitted, so the host's provider context stays byte-for-
    // structure and the queued user message remains visible to conversion.
    const provider = harness.host.captureProviderConversion(context);
    expect(provider).toEqual(context);
    expect(provider).toContain(queued);
  });

  it("rejects a context handler invoked after the marker timeout without changing the provider list", async () => {
    const harness = createContextHarness([origin, fallback]);
    const operation = await beginFallback(harness);
    await admitMarker(harness, operation.marker);
    harness.timer.fireNext();
    expect(harness.coordinator.state).toBe("terminal");
    const decision = harness.coordinator.terminalDecision;
    expect(decision?.kind).toBe("failed");
    if (decision?.kind !== "failed") {
      throw new Error("test setup: context timeout did not fail closed");
    }
    expect(decision.reason).toBe("context-timeout");

    const input = [failedAssistant, operation.marker];
    expect(await harness.host.triggerContext(input)).toEqual(input);
    expect(harness.host.captureProviderConversion(input)).toEqual(input);
  });
});
