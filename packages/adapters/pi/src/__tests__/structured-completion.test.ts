import { describe, expect, it } from "bun:test";
import {
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
