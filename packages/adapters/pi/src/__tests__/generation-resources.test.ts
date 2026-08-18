import { describe, expect, test } from "bun:test";
import {
  createModelFailoverCoordinatorCell,
  type PiGenerationModelFailoverPort,
  PiGenerationResourceOwner,
  shutdownModelFailoverCoordinator,
} from "../generation-resources.js";
import {
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

const ORIGIN: PiModelInfo = {
  provider: "origin",
  id: "first",
  name: "First",
  contextWindow: 8,
};
const FALLBACK: PiModelInfo = {
  provider: "fallback",
  id: "second",
  name: "Second",
  contextWindow: 16,
};
const FAILED_ASSISTANT = {
  role: "assistant",
  id: "failed-assistant",
  stopReason: "error",
  content: [{ type: "text", text: "bounded partial output" }],
};

function failedAssistantFingerprint(): PiAssistantFingerprint {
  const result = fingerprintPiAssistantMessage(FAILED_ASSISTANT);
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

interface LiveCoordinator {
  readonly coordinator: PiModelFailoverCoordinator;
  readonly timer: RecordingFakeTimerPort;
}

function liveCoordinator(
  generationId: string,
  nativeSessionId: string,
  onDecision?: (decision: unknown) => void,
): LiveCoordinator {
  const host = new RecordingFakePiHost({
    currentModel: ORIGIN,
    availableModels: [ORIGIN, FALLBACK],
  });
  const timer = new RecordingFakeTimerPort();
  const coordinator = createPiModelFailoverCoordinator({
    host: host.api,
    context: host.createSessionContext(),
    generationId,
    nativeSessionId,
    activationId: "activation-1",
    currentModel: ORIGIN,
    candidates: [ORIGIN, FALLBACK],
    timer,
    switchTimeoutMs: 100,
    markerTimeoutMs: 100,
    contextTimeoutMs: 100,
    getGenerationId: () => generationId,
    getNativeSessionId: () => nativeSessionId,
    ...(onDecision === undefined ? {} : { onDecision }),
  });
  return { coordinator, timer };
}

async function armFallback(
  coordinator: PiModelFailoverCoordinator,
): Promise<void> {
  const result = await coordinator.handleFailure({
    failureClass: "provider_unavailable",
    failedModel: ORIGIN,
    fingerprint: failedAssistantFingerprint(),
  });
  expect(result.isOk()).toBe(true);
}

/** A small generation-owned port used to observe owner disposal boundaries. */
class TrackedFailover implements PiGenerationModelFailoverPort {
  resetCalls = 0;
  shutdownCalls = 0;
  private live = true;
  private readonly timers: (() => void)[] = [];

  reset(): void {
    this.resetCalls += 1;
    this.live = false;
  }

  shutdown(): void {
    this.shutdownCalls += 1;
    this.live = false;
  }

  armTimer(callback: () => void): void {
    this.timers.push(() => {
      if (this.live) callback();
    });
  }

  fireTimers(): void {
    for (const timer of this.timers) timer();
  }
}

describe("generation model-failover resources", () => {
  test("one cell holds the active generation/session coordinator only", async () => {
    const cell = createModelFailoverCoordinatorCell();
    const decisions: unknown[] = [];
    const first = liveCoordinator("generation-1", "session-1", (decision) => {
      decisions.push(decision);
    });

    await armFallback(first.coordinator);
    cell.coordinator = first.coordinator;
    cell.generationId = "generation-1";

    expect(cell.coordinator).toBe(first.coordinator);
    expect(cell.generationId).toBe("generation-1");
    expect(first.coordinator.scope).toMatchObject({
      generationId: "generation-1",
      nativeSessionId: "session-1",
    });
    expect(first.timer.pending()).toHaveLength(1);

    const staleTimers = [...first.timer.scheduled];
    shutdownModelFailoverCoordinator(cell);
    shutdownModelFailoverCoordinator(cell);

    expect(cell.coordinator).toBeUndefined();
    expect(cell.generationId).toBeUndefined();
    expect(first.coordinator.terminalDecision).toMatchObject({
      kind: "failed",
      reason: "shutdown",
    });
    expect(decisions).toHaveLength(1);
    expect(first.timer.pending()).toHaveLength(0);

    const second = liveCoordinator("generation-2", "session-2");
    cell.coordinator = second.coordinator;
    cell.generationId = "generation-2";

    // A timer callback retained by the revoked generation cannot publish into
    // or clear the successor. Invoke cancelled callbacks directly to model a
    // hostile timer implementation that delivers late work.
    for (const timer of staleTimers) timer.callback();
    expect(cell.coordinator).toBe(second.coordinator);
    expect(cell.generationId).toBe("generation-2");
    expect(second.coordinator.state).toBe("armed");
    expect(decisions).toHaveLength(1);
  });

  test("resource-owner disposal is generation-local and idempotent", async () => {
    const owner = new PiGenerationResourceOwner("generation-1");
    const first = new TrackedFailover();
    owner.adoptModelFailover(first);

    expect((await owner.dispose()).isOk()).toBe(true);
    expect((await owner.dispose()).isOk()).toBe(true);
    expect(first.shutdownCalls).toBe(1);
    expect(first.resetCalls).toBe(0);

    // A disposed generation cannot capture a coordinator belonging to its
    // successor. The late adoption is shut down immediately and the old
    // disposal remains a no-op.
    const second = new TrackedFailover();
    owner.adoptModelFailover(second);
    expect(second.shutdownCalls).toBe(1);
    expect((await owner.dispose()).isOk()).toBe(true);
    expect(first.shutdownCalls).toBe(1);
    expect(second.shutdownCalls).toBe(1);
  });

  test("shutdown invalidates callbacks before a later generation is installed", () => {
    const cell = createModelFailoverCoordinatorCell();
    const first = new TrackedFailover();
    let staleMutations = 0;
    first.armTimer(() => {
      staleMutations += 1;
      cell.coordinator = undefined;
      cell.generationId = undefined;
    });
    cell.coordinator = first;
    cell.generationId = "generation-1";

    shutdownModelFailoverCoordinator(cell);
    const second = new TrackedFailover();
    cell.coordinator = second;
    cell.generationId = "generation-2";

    first.fireTimers();
    expect(staleMutations).toBe(0);
    expect(cell.coordinator).toBe(second);
    expect(cell.generationId).toBe("generation-2");
  });
});
