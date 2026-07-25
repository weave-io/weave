import { describe, expect, it } from "bun:test";
import {
  buildWeaveCompleteStepToolRegistration,
  parseStructuredCompletionCandidate,
  SingleCompletionCandidateRecorder,
  serializeCompletionCandidate,
  tryParseCompletionCandidateJson,
} from "../structured-completion.js";

describe("parseStructuredCompletionCandidate", () => {
  it("maps a missing candidate to CompletionSignalMissing", () => {
    const result = parseStructuredCompletionCandidate(undefined, "implement");
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe("CompletionSignalMissing");
  });

  it("accepts a valid success candidate", () => {
    const result = parseStructuredCompletionCandidate(
      { outcome: "success", method: "agent_signal", message: "done" },
      "implement",
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.outcome).toBe("success");
  });

  it("accepts declared artifact refs", () => {
    const result = parseStructuredCompletionCandidate(
      {
        outcome: "success",
        artifacts: [{ name: "report", path: "artifacts/report.md" }],
      },
      "implement",
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.artifacts).toHaveLength(1);
  });

  it("rejects an unclosed outcome value as malformed", () => {
    const result = parseStructuredCompletionCandidate(
      { outcome: "yolo" },
      "implement",
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe("CompletionSignalMalformed");
  });

  it("rejects a non-plain-object candidate", () => {
    const result = parseStructuredCompletionCandidate(
      "free-form prose",
      "implement",
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe("CompletionSignalMalformed");
  });

  it("rejects an unclosed completion method", () => {
    const result = parseStructuredCompletionCandidate(
      { outcome: "success", method: "vibes" },
      "implement",
    );
    expect(result.isErr()).toBe(true);
  });

  it("rejects an artifact entry missing a path", () => {
    const result = parseStructuredCompletionCandidate(
      { outcome: "success", artifacts: [{ name: "report" }] },
      "implement",
    );
    expect(result.isErr()).toBe(true);
  });

  it("rejects an oversized message", () => {
    const result = parseStructuredCompletionCandidate(
      { outcome: "success", message: "x".repeat(5000) },
      "implement",
    );
    expect(result.isErr()).toBe(true);
  });
});

describe("serializeCompletionCandidate / tryParseCompletionCandidateJson round trip", () => {
  it("round-trips a candidate through the bounded JSON channel", () => {
    const candidate = { outcome: "success", method: "agent_signal" };
    const serialized = serializeCompletionCandidate(candidate);
    const parsed = tryParseCompletionCandidateJson(serialized);
    expect(parsed).toEqual(candidate);
  });

  it("returns undefined for malformed JSON rather than throwing", () => {
    expect(tryParseCompletionCandidateJson("{not json")).toBeUndefined();
  });

  it("returns undefined for oversized input", () => {
    expect(
      tryParseCompletionCandidateJson("x".repeat(100_000)),
    ).toBeUndefined();
  });
});

describe("SingleCompletionCandidateRecorder", () => {
  it("records exactly one candidate and rejects a duplicate", () => {
    const recorder = new SingleCompletionCandidateRecorder();
    const first = recorder.record({ outcome: "success" });
    const second = recorder.record({ outcome: "success" });
    expect(first.isOk()).toBe(true);
    expect(second.isErr()).toBe(true);
    expect(recorder.hadDuplicateAttempt()).toBe(true);
    expect(recorder.take()).toEqual({ outcome: "success" });
  });
});

describe("buildWeaveCompleteStepToolRegistration", () => {
  it("marks the registration as a control channel and keeps an execute-capability resolver as a fail-closed fallback", () => {
    const recorder = new SingleCompletionCandidateRecorder();
    const registration = buildWeaveCompleteStepToolRegistration({
      stepName: "implement",
      recorder,
      isWindowOpen: () => true,
    });
    expect(registration.controlChannel).toBe(true);
    const resolved = registration
      .resolver({
        call: { outcome: "success" },
        context: {
          toolIdentity: "weave_complete_step",
          owner: registration.owner,
          revision: registration.revision,
        },
      })
      ._unsafeUnwrap();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      unresolved: false,
      capability: "execute",
    });
  });

  it("the tool's own execute() records the candidate the recorder later hands to settlement (recorder receives the candidate)", async () => {
    const recorder = new SingleCompletionCandidateRecorder();
    const attempts: string[] = [];
    const registration = buildWeaveCompleteStepToolRegistration({
      stepName: "implement",
      recorder,
      isWindowOpen: () => true,
      onAttempt: (attempt) => attempts.push(attempt.outcome),
    });
    const result = await registration.tool.execute(
      "tc-1",
      { outcome: "success", method: "agent_signal", message: "done" },
      undefined,
      undefined,
      {} as never,
    );
    expect(attempts).toEqual(["recorded"]);
    expect(recorder.take()).toEqual({
      outcome: "success",
      method: "agent_signal",
      message: "done",
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify({ ok: true }),
    });
  });

  it("a call that arrives after the completion window has closed is recorded as 'late', not authored into the recorder", async () => {
    const recorder = new SingleCompletionCandidateRecorder();
    const attempts: string[] = [];
    const registration = buildWeaveCompleteStepToolRegistration({
      stepName: "implement",
      recorder,
      isWindowOpen: () => false,
      onAttempt: (attempt) => attempts.push(attempt.outcome),
    });
    await registration.tool.execute(
      "tc-1",
      { outcome: "success" },
      undefined,
      undefined,
      {} as never,
    );
    expect(attempts).toEqual(["late"]);
    expect(recorder.take()).toBeUndefined();
  });
});
