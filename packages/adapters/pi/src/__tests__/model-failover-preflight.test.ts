import { describe, expect, it } from "bun:test";
import {
  checkPiFailoverPreflight,
  preflightPiFailoverCandidate,
} from "../model-failover-preflight.js";
import type { PiModelInfo } from "../model-resolution.js";
import { RecordingFakePiHost } from "./fakes/fake-pi-host.js";

const origin: PiModelInfo = {
  provider: "origin",
  id: "first",
  contextWindow: 8,
};
const fallback: PiModelInfo = {
  provider: "fallback",
  id: "second",
  contextWindow: 16,
};

function input(
  overrides: Partial<Parameters<typeof checkPiFailoverPreflight>[0]> = {},
) {
  return {
    candidate: fallback,
    failedModel: origin,
    failureClass: "timeout" as const,
    expectedGenerationId: "generation-1",
    currentGenerationId: "generation-1",
    expectedSessionId: "session-1",
    currentSessionId: "session-1",
    idle: true,
    pendingInput: false,
    cancelled: false,
    availableModels: [origin, fallback],
    ...overrides,
  };
}

describe("Pi model-failover preflight", () => {
  it("requires idle, no pending input, matching scope, and cancellation clearance", () => {
    expect(checkPiFailoverPreflight(input())._unsafeUnwrap()).toEqual({
      status: "eligible",
    });
    expect(
      checkPiFailoverPreflight(input({ idle: false }))._unsafeUnwrap(),
    ).toEqual({
      status: "skip",
      reason: "not-idle",
    });
    expect(
      checkPiFailoverPreflight(input({ pendingInput: true }))._unsafeUnwrap(),
    ).toEqual({ status: "skip", reason: "pending-input" });
    expect(
      checkPiFailoverPreflight(
        input({ pendingInput: undefined }),
      )._unsafeUnwrap(),
    ).toEqual({ status: "skip", reason: "pending-input-unknown" });
    expect(
      checkPiFailoverPreflight(
        input({ currentGenerationId: "generation-2" }),
      )._unsafeUnwrap(),
    ).toEqual({ status: "skip", reason: "stale-generation" });
    expect(
      checkPiFailoverPreflight(
        input({ currentSessionId: "session-2" }),
      )._unsafeUnwrap(),
    ).toEqual({ status: "skip", reason: "stale-session" });
    expect(
      checkPiFailoverPreflight(input({ cancelled: true }))._unsafeUnwrap(),
    ).toEqual({ status: "skip", reason: "cancelled" });
  });

  it("requires one authenticated catalog entry and maps auth failures to candidate skips", () => {
    expect(
      checkPiFailoverPreflight(
        input({ availableModels: [origin] }),
      )._unsafeUnwrap(),
    ).toEqual({ status: "skip", reason: "candidate-not-in-catalog" });
    expect(
      checkPiFailoverPreflight(
        input({ availableModels: [origin, fallback, fallback] }),
      )._unsafeUnwrap(),
    ).toEqual({ status: "skip", reason: "candidate-catalog-ambiguous" });
    expect(
      checkPiFailoverPreflight(input({ authAvailable: false }))._unsafeUnwrap(),
    ).toEqual({
      status: "skip",
      reason: "provider-credentials-unavailable",
    });
  });

  it("requires a strictly larger window for unrecovered overflow", () => {
    expect(
      checkPiFailoverPreflight(
        input({ failureClass: "context_overflow_unrecovered" }),
      )._unsafeUnwrap(),
    ).toEqual({ status: "eligible" });
    expect(
      checkPiFailoverPreflight(
        input({
          failureClass: "context_overflow_unrecovered",
          candidate: { ...origin },
        }),
      )._unsafeUnwrap(),
    ).toEqual({ status: "skip", reason: "context-window-ineligible" });
    expect(
      checkPiFailoverPreflight(
        input({
          failureClass: "context_overflow_unrecovered",
          candidate: { provider: "fallback", id: "unknown" },
        }),
      )._unsafeUnwrap(),
    ).toEqual({ status: "skip", reason: "candidate-not-in-catalog" });
  });

  it("reads the public fake host and converts throwing probes into typed failures", async () => {
    const host = new RecordingFakePiHost({
      currentModel: origin,
      availableModels: [origin, fallback],
    });
    const context = host.createSessionContext();
    const eligible = await preflightPiFailoverCandidate({
      candidate: fallback,
      failedModel: origin,
      failureClass: "timeout",
      expectedGenerationId: "generation-1",
      currentGenerationId: "generation-1",
      expectedSessionId: "session-1",
      currentSessionId: "session-1",
      session: context,
    });
    expect(eligible.isOk()).toBe(true);
    expect(eligible._unsafeUnwrap()).toEqual({ status: "eligible" });

    host.poisonGetAvailableModels();
    const failed = await preflightPiFailoverCandidate({
      candidate: fallback,
      failedModel: origin,
      failureClass: "timeout",
      expectedGenerationId: "generation-1",
      currentGenerationId: "generation-1",
      expectedSessionId: "session-1",
      currentSessionId: "session-1",
      session: host.createSessionContext(),
    });
    expect(failed.isErr()).toBe(true);
    expect(failed._unsafeUnwrapErr()).toEqual({ type: "SessionProbeFailed" });
  });

  it("invokes the runtime authentication accessor once and retains only its boolean result", async () => {
    const host = new RecordingFakePiHost({
      currentModel: origin,
      availableModels: [origin, fallback],
    });
    let calls = 0;
    const result = await preflightPiFailoverCandidate({
      candidate: fallback,
      failedModel: origin,
      failureClass: "timeout",
      expectedGenerationId: "generation-1",
      currentGenerationId: "generation-1",
      expectedSessionId: "session-1",
      currentSessionId: "session-1",
      session: host.createSessionContext(),
      isAuthenticated: () => {
        calls += 1;
        return true;
      },
    });
    expect(result._unsafeUnwrap()).toEqual({ status: "eligible" });
    expect(calls).toBe(1);
    expect(JSON.stringify(result._unsafeUnwrap())).not.toContain("token");
  });
});
