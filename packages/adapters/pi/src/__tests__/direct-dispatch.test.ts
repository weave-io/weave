import { describe, expect, it } from "bun:test";
import { ok, okAsync } from "neverthrow";
import {
  FakeDirectDispatchPort,
  TransportDirectDispatchPort,
} from "../direct-dispatch.js";
import { serializeCompletionCandidate } from "../structured-completion.js";

const INPUT = {
  workflowInstanceId: "wf-1",
  leaseId: "lease-1",
  stepName: "implement",
  agentName: "shuttle",
  composedPrompt: "do the work",
  cwd: "/tmp/project",
  correlationId: "corr-1",
  models: ["claude-sonnet-4-5"],
  effectiveToolPolicy: undefined,
  delegationTargets: [],
};

describe("TransportDirectDispatchPort", () => {
  it("interprets a completed settlement's summary as a structured completion candidate", async () => {
    const port = new TransportDirectDispatchPort(() =>
      okAsync({
        outcome: "completed" as const,
        summary: serializeCompletionCandidate({
          outcome: "success",
          method: "agent_signal",
        }),
      }),
    );
    const result = await port.dispatch(INPUT);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.outcome).toBe("success");
  });

  it("maps a failed settlement to a typed adapter failure", async () => {
    const port = new TransportDirectDispatchPort(() =>
      okAsync({ outcome: "failed" as const, reason: "process-crashed" }),
    );
    const result = await port.dispatch(INPUT);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("ChildSpawnFailed");
  });

  it("rejects a completed settlement whose summary is unparseable prose (never treated as free-form success)", async () => {
    const port = new TransportDirectDispatchPort(() =>
      okAsync({
        outcome: "completed" as const,
        summary: "just some free-form prose",
      }),
    );
    const result = await port.dispatch(INPUT);
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe("CompletionSignalMissing");
  });

  it("rejects a completed settlement whose summary is valid JSON but an invalid completion shape", async () => {
    const port = new TransportDirectDispatchPort(() =>
      okAsync({
        outcome: "completed" as const,
        summary: '{"outcome":"not-a-real-outcome"}',
      }),
    );
    const result = await port.dispatch(INPUT);
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe("CompletionSignalMalformed");
  });

  it("rejects a completed settlement with no summary at all as a missing completion signal", async () => {
    const port = new TransportDirectDispatchPort(() =>
      okAsync({ outcome: "completed" as const }),
    );
    const result = await port.dispatch(INPUT);
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe("CompletionSignalMissing");
  });
});

describe("FakeDirectDispatchPort", () => {
  it("records every call for correlation assertions and returns scripted candidates in order", async () => {
    const port = new FakeDirectDispatchPort();
    port.enqueue(ok({ outcome: "success" }));
    const result = await port.dispatch(INPUT);
    expect(result.isOk()).toBe(true);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toEqual(INPUT);
  });

  it("fails closed when no scripted response is queued", async () => {
    const port = new FakeDirectDispatchPort();
    const result = await port.dispatch(INPUT);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("ChildSpawnFailed");
  });
});
