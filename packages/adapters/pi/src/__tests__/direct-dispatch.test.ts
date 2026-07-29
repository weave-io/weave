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
  composedPrompt: "You are Shuttle.",
  taskPrompt: "do the work",
  cwd: "/tmp/project",
  correlationId: "corr-1",
  models: ["claude-sonnet-4-5"],
  delegationTargets: [],
};

describe("TransportDirectDispatchPort", () => {
  it("interprets only the structured completion candidate", async () => {
    const port = new TransportDirectDispatchPort(() =>
      okAsync({
        outcome: "completed" as const,
        completionCandidate: serializeCompletionCandidate({
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

  it("rejects an unparseable candidate even when prose and intervention metadata exist", async () => {
    const port = new TransportDirectDispatchPort(() =>
      okAsync({
        outcome: "completed" as const,
        completionCandidate: "just some free-form prose",
        assistantOutput:
          "final output that must not become completion authority",
        interventionCount: 4,
      }),
    );
    const result = await port.dispatch(INPUT);
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe("CompletionSignalMissing");
  });

  it("rejects a completed settlement whose candidate is valid JSON but an invalid completion shape", async () => {
    const port = new TransportDirectDispatchPort(() =>
      okAsync({
        outcome: "completed" as const,
        completionCandidate: '{"outcome":"not-a-real-outcome"}',
      }),
    );
    const result = await port.dispatch(INPUT);
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe("CompletionSignalMalformed");
  });

  it("rejects a missing candidate even when final output, prose, and count exist", async () => {
    const port = new TransportDirectDispatchPort(() =>
      okAsync({
        outcome: "completed" as const,
        assistantOutput:
          "final output that must not become completion authority",
        interventionText: "late free-text intervention",
        interventionCount: 9,
      }),
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
