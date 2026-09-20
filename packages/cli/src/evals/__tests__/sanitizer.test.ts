/**
 * Unit tests for `sanitizer.ts` — the parts a user cannot observe.
 *
 * The promises a reader of a published bundle can check are asserted end to
 * end in [`tests/evals/publish-safety.scenario.test.ts`](../../../../../tests/evals/publish-safety.scenario.test.ts):
 * every sensitive field is stripped, unknown shapes are dropped, explanations
 * carrying injection payloads never reach a public artifact, and provenance
 * publishes hashes rather than prompt text. The cases that asserted those
 * through `sanitizeCaseResultSummary()`, `sanitizeProvenanceRecord()`,
 * `sanitizeProvenanceManifest()` and the `SENSITIVE_FIELD_NAMES` membership
 * list were removed there; all four scenarios were watched fail against a
 * neutered sanitizer before the deletion.
 *
 * What is left here is deliberately internal:
 *
 *   - **`assertPublishSafe()` / `assertJsonPublishSafe()`** — the publish-mode
 *     guards. While the allowlist projection works they never fire, so no
 *     written file reveals their behaviour. They exist to catch a future
 *     bypass, and these are the only tests that exercise one.
 *   - **`sanitizeScoreRecord()`, `dropUnknownFields()`, `REDACTED`,
 *     `truncateExplanation()`, `buildExplanation()`, `assertExplanationSafe()`
 *     and `FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS`** — exported API with no
 *     production caller in this repository. The runners build explanations via
 *     `buildPublicExplanation()` in `langchain-agent-evals.ts` and redact with
 *     their own patterns, so nothing a user does reaches these, and no scenario
 *     can cover them. Kept, and flagged: while they stay uncalled they are
 *     candidates for removal, at which point these tests go with them.
 *
 * Test isolation: no file I/O, no network, no spawned process; fixtures inline.
 */

import { describe, expect, it } from "bun:test";
import { EXPLANATION_MAX_CHARS } from "../report-schema.js";
import {
  assertExplanationSafe,
  assertJsonPublishSafe,
  assertPublishSafe,
  buildExplanation,
  dropUnknownFields,
  FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS,
  REDACTED,
  sanitizeScoreRecord,
  truncateExplanation,
} from "../sanitizer.js";
import type { NormalizedScoreRecord } from "../types.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeNormalizedScoreRecord(
  overrides: Partial<NormalizedScoreRecord> = {},
): NormalizedScoreRecord {
  return {
    caseId: "route-to-shuttle",
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "loom-routing",
    dimensions: {
      routingCorrectness: {
        score: 1.0,
        rationale: "Correct routing.",
        applicable: true,
      },
      delegationCorrectness: {
        score: 1.0,
        rationale: "Not applicable.",
        applicable: false,
      },
      executionCompleteness: {
        score: 1.0,
        rationale: "Not applicable.",
        applicable: false,
      },
      rationaleQuality: {
        score: 0.8,
        rationale: "Good explanation.",
        applicable: true,
      },
    },
    weightedTotal: 0.9,
    passed: true,
    required: true,
    scoredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// REDACTED constant
// ---------------------------------------------------------------------------

describe("REDACTED", () => {
  it("is a recognizable sentinel string", () => {
    expect(REDACTED).toBe("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// sanitizeScoreRecord
// ---------------------------------------------------------------------------

describe("sanitizeScoreRecord", () => {
  it("retains caseId", () => {
    const record = makeNormalizedScoreRecord({ caseId: "my-case" });
    expect(sanitizeScoreRecord(record).caseId).toBe("my-case");
  });

  it("retains modelId", () => {
    const record = makeNormalizedScoreRecord({ modelId: "openai/gpt-4o" });
    expect(sanitizeScoreRecord(record).modelId).toBe("openai/gpt-4o");
  });

  it("retains weightedTotal", () => {
    const record = makeNormalizedScoreRecord({ weightedTotal: 0.75 });
    expect(sanitizeScoreRecord(record).weightedTotal).toBeCloseTo(0.75);
  });

  it("retains passed and required", () => {
    const record = makeNormalizedScoreRecord({ passed: false, required: true });
    const sanitized = sanitizeScoreRecord(record);
    expect(sanitized.passed).toBe(false);
    expect(sanitized.required).toBe(true);
  });

  it("retains scoredAt", () => {
    const ts = "2026-06-10T12:00:00.000Z";
    const record = makeNormalizedScoreRecord({ scoredAt: ts });
    expect(sanitizeScoreRecord(record).scoredAt).toBe(ts);
  });

  it("drops rationale from all dimensions", () => {
    const record = makeNormalizedScoreRecord();
    const sanitized = sanitizeScoreRecord(record);

    for (const dim of Object.values(sanitized.dimensions)) {
      expect("rationale" in dim).toBe(false);
    }
  });

  it("retains score and applicable from all dimensions", () => {
    const record = makeNormalizedScoreRecord();
    const sanitized = sanitizeScoreRecord(record);

    expect(sanitized.dimensions.routingCorrectness.score).toBe(1.0);
    expect(sanitized.dimensions.routingCorrectness.applicable).toBe(true);
    expect(sanitized.dimensions.rationaleQuality.score).toBe(0.8);
    expect(sanitized.dimensions.rationaleQuality.applicable).toBe(true);
    expect(sanitized.dimensions.delegationCorrectness.applicable).toBe(false);
  });

  it("serialized output contains no rationale field", () => {
    const record = makeNormalizedScoreRecord();
    const json = JSON.stringify(sanitizeScoreRecord(record));
    expect(json).not.toContain('"rationale"');
  });

  it("is deterministic for identical inputs", () => {
    const record = makeNormalizedScoreRecord();
    const s1 = JSON.stringify(sanitizeScoreRecord(record));
    const s2 = JSON.stringify(sanitizeScoreRecord(record));
    expect(s1).toBe(s2);
  });
});

// ---------------------------------------------------------------------------
// dropUnknownFields
// ---------------------------------------------------------------------------

describe("dropUnknownFields", () => {
  it("retains only allowlisted fields", () => {
    const input = { foo: 1, bar: 2, baz: 3 };
    const result = dropUnknownFields(input, ["foo", "bar"]);
    expect(result).toEqual({ foo: 1, bar: 2 });
  });

  it("returns empty object when no fields are allowlisted", () => {
    const input = { foo: 1, bar: 2 };
    const result = dropUnknownFields(input, []);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("returns all fields when all are allowlisted", () => {
    const input = { foo: 1, bar: 2 };
    const result = dropUnknownFields(input, ["foo", "bar"]);
    expect(result).toEqual({ foo: 1, bar: 2 });
  });

  it("silently drops unknown fields", () => {
    const input = {
      safe: "value",
      secret: "apiKey",
      rawContent: "prompt text",
    };
    const result = dropUnknownFields(input, ["safe"]);
    expect("secret" in result).toBe(false);
    expect("rawContent" in result).toBe(false);
    expect((result as Record<string, unknown>).safe).toBe("value");
  });

  it("does not mutate the input object", () => {
    const input = { foo: 1, bar: 2 };
    const result = dropUnknownFields(input, ["foo"]);
    expect(input).toEqual({ foo: 1, bar: 2 }); // unchanged
    expect("bar" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertPublishSafe
// ---------------------------------------------------------------------------

describe("assertPublishSafe", () => {
  it("returns ok for a safe object", () => {
    const obj = { caseId: "test", passed: true, score: 0.9 };
    const result = assertPublishSafe(obj);
    expect(result.isOk()).toBe(true);
  });

  it("returns err for an object with composedPrompt", () => {
    const obj = { composedPrompt: "You are Loom..." };
    const result = assertPublishSafe(obj);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("PublishSafetyViolation");
    if (error.type === "PublishSafetyViolation") {
      expect(error.field).toBe("composedPrompt");
    }
  });

  it("returns err for an object with rawContent", () => {
    const obj = { rawContent: "Model said..." };
    const result = assertPublishSafe(obj);
    expect(result.isErr()).toBe(true);
  });

  it("returns err for an object with transcript", () => {
    const obj = { transcript: [{ role: "user", content: "hello" }] };
    const result = assertPublishSafe(obj as unknown as Record<string, unknown>);
    expect(result.isErr()).toBe(true);
  });

  it("returns err with RawArtifactInPublishOutput when rawArtifact is present", () => {
    const obj = { rawArtifact: { caseId: "test" } };
    const result = assertPublishSafe(obj as unknown as Record<string, unknown>);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("RawArtifactInPublishOutput");
  });

  it("returns err with RawArtifactInPublishOutput when rawArtifacts array is present", () => {
    const obj = { rawArtifacts: [] };
    const result = assertPublishSafe(obj as unknown as Record<string, unknown>);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("RawArtifactInPublishOutput");
  });

  it("returns err for an object with rationale", () => {
    const obj = { rationale: "The model scored well because..." };
    const result = assertPublishSafe(obj);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("PublishSafetyViolation");
  });

  it("returns err for an object with env field", () => {
    const obj = { env: { API_KEY: "secret" } };
    const result = assertPublishSafe(obj as unknown as Record<string, unknown>);
    expect(result.isErr()).toBe(true);
  });

  it("returns err for an object with cause field", () => {
    const obj = { cause: new Error("network failure") };
    const result = assertPublishSafe(obj as unknown as Record<string, unknown>);
    expect(result.isErr()).toBe(true);
  });

  it("returns err for an object with logTail field", () => {
    const obj = { logTail: ["line 1", "line 2"] };
    const result = assertPublishSafe(obj as unknown as Record<string, unknown>);
    expect(result.isErr()).toBe(true);
  });

  it("error message includes the context string", () => {
    const obj = { composedPrompt: "secret" };
    const result = assertPublishSafe(obj, "test-context");
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.message).toContain("test-context");
  });

  it("safe object passes even with many allowed fields", () => {
    const obj = {
      caseId: "x",
      modelId: "y",
      suite: "z",
      passed: true,
      required: false,
      weightedTotal: 1.0,
      scoredAt: "2026-01-01T00:00:00.000Z",
      dryRun: false,
    };
    const result = assertPublishSafe(obj);
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assertJsonPublishSafe
// ---------------------------------------------------------------------------

describe("assertJsonPublishSafe", () => {
  it("returns ok for clean JSON", () => {
    const json = JSON.stringify({ caseId: "x", passed: true });
    const result = assertJsonPublishSafe(json);
    expect(result.isOk()).toBe(true);
  });

  it("returns err when JSON contains composedPrompt key", () => {
    const json = JSON.stringify({ composedPrompt: "You are an agent..." });
    const result = assertJsonPublishSafe(json);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("UnsanitizedOutputDetected");
    if (error.type === "UnsanitizedOutputDetected") {
      expect(error.field).toBe("composedPrompt");
    }
  });

  it("returns err when JSON contains rawContent key", () => {
    const json = JSON.stringify({ rawContent: "hello world" });
    const result = assertJsonPublishSafe(json);
    expect(result.isErr()).toBe(true);
  });

  it("returns err when JSON contains rationale key", () => {
    const json = JSON.stringify({
      dimensions: {
        routingCorrectness: {
          score: 1.0,
          rationale: "Good.",
          applicable: true,
        },
      },
    });
    const result = assertJsonPublishSafe(json);
    expect(result.isErr()).toBe(true);
  });

  it("returns err when JSON contains transcript key", () => {
    const json = JSON.stringify({ transcript: [] });
    const result = assertJsonPublishSafe(json);
    expect(result.isErr()).toBe(true);
  });

  it("returns err when JSON contains logTail key", () => {
    const json = JSON.stringify({ logTail: ["error: ..."] });
    const result = assertJsonPublishSafe(json);
    expect(result.isErr()).toBe(true);
  });

  it("returns err when JSON contains cause key", () => {
    const json = JSON.stringify({ cause: "network timeout" });
    const result = assertJsonPublishSafe(json);
    expect(result.isErr()).toBe(true);
  });

  it("returns err when JSON contains dimensionRationales key", () => {
    const json = JSON.stringify({
      dimensionRationales: { routingCorrectness: "Correct!" },
    });
    const result = assertJsonPublishSafe(json);
    expect(result.isErr()).toBe(true);
  });

  it("error message includes context string", () => {
    const json = JSON.stringify({ composedPrompt: "secret" });
    const result = assertJsonPublishSafe(json, "my-file.json");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain("my-file.json");
  });

  it("passes for a full sanitized case result summary JSON", () => {
    const summary = {
      caseId: "route-to-shuttle",
      modelId: "anthropic/claude-sonnet-4.5",
      suite: "loom-routing",
      passed: true,
      required: true,
      weightedTotal: 0.9,
      dimensionScores: {
        routingCorrectness: { score: 1.0, applicable: true },
        delegationCorrectness: { score: 1.0, applicable: false },
        executionCompleteness: { score: 1.0, applicable: false },
        rationaleQuality: { score: 0.8, applicable: true },
      },
      scoredAt: "2026-01-01T00:00:00.000Z",
      dryRun: false,
    };
    const json = JSON.stringify(summary);
    const result = assertJsonPublishSafe(json);
    expect(result.isOk()).toBe(true);
  });

  it("detects sensitive field anywhere in nested JSON", () => {
    const json = JSON.stringify({
      outer: {
        inner: {
          composedPrompt: "nested secret",
        },
      },
    });
    const result = assertJsonPublishSafe(json);
    expect(result.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// localDiagnostic — blocked by the publish guards
// ---------------------------------------------------------------------------

describe("the publish guards reject a local-only scorer diagnostic", () => {
  it("assertPublishSafe rejects an object with a localDiagnostic field", () => {
    const obj = {
      caseId: "some-case",
      errorType: "ScorerAdapterError",
      classification: "scoring-adapter-failure",
      localDiagnostic: "LangChain call failed: timeout after 30s",
    };
    const result = assertPublishSafe(
      obj as unknown as Record<string, unknown>,
      "RawErrorSummary",
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("PublishSafetyViolation");
    if (error.type === "PublishSafetyViolation") {
      expect(error.field).toBe("localDiagnostic");
    }
  });

  it("assertJsonPublishSafe rejects JSON containing 'localDiagnostic' key", () => {
    const json = JSON.stringify({
      errorSummary: {
        errorType: "ScorerAdapterError",
        classification: "scoring-adapter-failure",
        localDiagnostic: "Some debug info",
      },
    });
    const result = assertJsonPublishSafe(json, "bundle-with-diagnostic");
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("UnsanitizedOutputDetected");
    if (error.type === "UnsanitizedOutputDetected") {
      expect(error.field).toBe("localDiagnostic");
    }
  });

  it("assertPublishSafe allows a RawErrorSummary without localDiagnostic", () => {
    const obj = {
      errorType: "ScorerAdapterError",
      classification: "scoring-adapter-failure",
    };
    const result = assertPublishSafe(
      obj as unknown as Record<string, unknown>,
      "RawErrorSummary",
    );
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// truncateExplanation
// ---------------------------------------------------------------------------

describe("truncateExplanation", () => {
  it("returns the string unchanged when within limit", () => {
    const text = "A".repeat(EXPLANATION_MAX_CHARS);
    expect(truncateExplanation(text)).toBe(text);
  });

  it("returns the string unchanged for empty input", () => {
    expect(truncateExplanation("")).toBe("");
  });

  it("truncates strings exceeding EXPLANATION_MAX_CHARS", () => {
    const text = "A".repeat(EXPLANATION_MAX_CHARS + 50);
    const result = truncateExplanation(text);
    expect(result.length).toBe(EXPLANATION_MAX_CHARS);
  });

  it("appends ellipsis character when truncating", () => {
    const text = "A".repeat(EXPLANATION_MAX_CHARS + 1);
    const result = truncateExplanation(text);
    expect(result.endsWith("…")).toBe(true);
  });

  it("produces a string of exactly EXPLANATION_MAX_CHARS when truncated", () => {
    const text = "X".repeat(EXPLANATION_MAX_CHARS + 100);
    const result = truncateExplanation(text);
    expect(result.length).toBe(EXPLANATION_MAX_CHARS);
  });

  it("short strings are returned unchanged", () => {
    const text = "Short explanation.";
    expect(truncateExplanation(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS
// ---------------------------------------------------------------------------

describe("FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS", () => {
  it("contains raw_rationale", () => {
    expect(FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has("raw_rationale")).toBe(
      true,
    );
  });

  it("contains dimension_rationale", () => {
    expect(
      FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has("dimension_rationale"),
    ).toBe(true);
  });

  it("contains transcript_content", () => {
    expect(
      FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has("transcript_content"),
    ).toBe(true);
  });

  it("contains raw_content", () => {
    expect(FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has("raw_content")).toBe(
      true,
    );
  });

  it("contains composed_prompt", () => {
    expect(
      FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has("composed_prompt"),
    ).toBe(true);
  });

  it("contains raw_prompt", () => {
    expect(FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has("raw_prompt")).toBe(
      true,
    );
  });

  it("contains llm_freeform_summary", () => {
    expect(
      FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has("llm_freeform_summary"),
    ).toBe(true);
  });

  it("contains chain_of_thought", () => {
    expect(
      FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has("chain_of_thought"),
    ).toBe(true);
  });

  it("contains cot", () => {
    expect(FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has("cot")).toBe(true);
  });

  it("contains thinking", () => {
    expect(FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has("thinking")).toBe(true);
  });

  it("does not contain score_bucket_label (allowed source)", () => {
    expect(
      FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has("score_bucket_label"),
    ).toBe(false);
  });

  it("does not contain operator_note (allowed source)", () => {
    expect(FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has("operator_note")).toBe(
      false,
    );
  });

  it("does not contain rubric_template (allowed source)", () => {
    expect(
      FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has("rubric_template"),
    ).toBe(false);
  });

  it("does not contain structured_signal (allowed source)", () => {
    expect(
      FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has("structured_signal"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildExplanation
// ---------------------------------------------------------------------------

describe("buildExplanation", () => {
  it("returns ok for a valid score_bucket_label explanation", () => {
    const result = buildExplanation(
      "Routing matched expected agent.",
      "score_bucket_label",
      "bucket_derivation",
    );
    expect(result.isOk()).toBe(true);
  });

  it("returns ok for a valid rubric_template explanation", () => {
    const result = buildExplanation(
      "Case passes per rubric template.",
      "rubric_template",
      "rubric_file",
    );
    expect(result.isOk()).toBe(true);
  });

  it("returns ok for a valid structured_signal explanation", () => {
    const result = buildExplanation(
      "routing_matched: true, chain_verified: false",
      "structured_signal",
      "typed_score_fields",
    );
    expect(result.isOk()).toBe(true);
  });

  it("returns ok for a valid operator_note explanation", () => {
    const result = buildExplanation(
      "Confirmed correct by team lead.",
      "operator_note",
      "human_review",
    );
    expect(result.isOk()).toBe(true);
  });

  // --- Forbidden source descriptor rejection ---

  it("returns err with ExplanationSourceForbidden for 'raw_rationale'", () => {
    const result = buildExplanation(
      "The model was correct.",
      "operator_note",
      "raw_rationale",
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ExplanationSourceForbidden");
    if (error.type === "ExplanationSourceForbidden") {
      expect(error.sourceDescriptor).toBe("raw_rationale");
    }
  });

  it("returns err with ExplanationSourceForbidden for 'transcript_content'", () => {
    const result = buildExplanation(
      "Some content.",
      "operator_note",
      "transcript_content",
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ExplanationSourceForbidden");
  });

  it("returns err with ExplanationSourceForbidden for 'llm_freeform_summary'", () => {
    const result = buildExplanation(
      "The model performed well.",
      "operator_note",
      "llm_freeform_summary",
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ExplanationSourceForbidden");
  });

  it("returns err with ExplanationSourceForbidden for 'composed_prompt'", () => {
    const result = buildExplanation(
      "You are Loom...",
      "operator_note",
      "composed_prompt",
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("ExplanationSourceForbidden");
  });

  it("returns err with ExplanationSourceForbidden for 'raw_content'", () => {
    const result = buildExplanation(
      "Some model output.",
      "operator_note",
      "raw_content",
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("ExplanationSourceForbidden");
  });

  it("returns err with ExplanationSourceForbidden for 'chain_of_thought'", () => {
    const result = buildExplanation(
      "Step 1, Step 2...",
      "operator_note",
      "chain_of_thought",
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("ExplanationSourceForbidden");
  });

  it("returns err with ExplanationSourceForbidden for 'dimension_rationale'", () => {
    const result = buildExplanation(
      "routing was correct",
      "operator_note",
      "dimension_rationale",
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("ExplanationSourceForbidden");
  });

  // --- Overlong text rejection ---

  it("returns err with ExplanationTooLong when text exceeds EXPLANATION_MAX_CHARS", () => {
    const result = buildExplanation(
      "A".repeat(EXPLANATION_MAX_CHARS + 1),
      "operator_note",
      "human_review",
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ExplanationTooLong");
    if (error.type === "ExplanationTooLong") {
      expect(error.actualLength).toBe(EXPLANATION_MAX_CHARS + 1);
      expect(error.maxLength).toBe(EXPLANATION_MAX_CHARS);
    }
  });

  it("accepts text of exactly EXPLANATION_MAX_CHARS", () => {
    const result = buildExplanation(
      "A".repeat(EXPLANATION_MAX_CHARS),
      "operator_note",
      "human_review",
    );
    expect(result.isOk()).toBe(true);
  });

  // --- Forbidden pattern rejection ---

  it("returns err with ExplanationForbiddenPattern for <thinking> tag", () => {
    const result = buildExplanation(
      "<thinking>Reason here</thinking>",
      "operator_note",
      "human_review",
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ExplanationForbiddenPattern");
    if (error.type === "ExplanationForbiddenPattern") {
      expect(error.patternName).toBe("chain_of_thought_xml");
    }
  });

  it("returns err with ExplanationForbiddenPattern for transcript role marker", () => {
    const result = buildExplanation(
      "Observed:\nUser: do X\nAssistant: done",
      "operator_note",
      "human_review",
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ExplanationForbiddenPattern");
    if (error.type === "ExplanationForbiddenPattern") {
      expect(error.patternName).toBe("transcript_role_marker");
    }
  });

  it("returns err with ExplanationForbiddenPattern for rationale: marker", () => {
    const result = buildExplanation(
      "rationale: model selected correctly",
      "operator_note",
      "human_review",
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ExplanationForbiddenPattern");
    if (error.type === "ExplanationForbiddenPattern") {
      expect(error.patternName).toBe("raw_rationale_marker");
    }
  });

  it("returns err with ExplanationForbiddenPattern for secret token pattern", () => {
    const result = buildExplanation(
      "Using key: sk-abcdefghijklmnopqrstu",
      "operator_note",
      "human_review",
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ExplanationForbiddenPattern");
    if (error.type === "ExplanationForbiddenPattern") {
      expect(error.patternName).toBe("secret_token_pattern");
    }
  });

  // Source descriptor check fires before length check
  it("returns ExplanationSourceForbidden before ExplanationTooLong when both fail", () => {
    const result = buildExplanation(
      "A".repeat(EXPLANATION_MAX_CHARS + 1),
      "operator_note",
      "raw_rationale", // forbidden source
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("ExplanationSourceForbidden");
  });

  // Length check fires before pattern check
  it("returns ExplanationTooLong before ExplanationForbiddenPattern when both fail", () => {
    const paddedRationale =
      "rationale: some text " + "A".repeat(EXPLANATION_MAX_CHARS);
    const result = buildExplanation(
      paddedRationale,
      "operator_note",
      "human_review",
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("ExplanationTooLong");
  });

  it("returned BoundedExplanation has correct text and source", () => {
    const result = buildExplanation(
      "Routing was correct.",
      "score_bucket_label",
      "bucket_derivation",
    );
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.text).toBe("Routing was correct.");
    expect(value.source).toBe("score_bucket_label");
  });
});

// ---------------------------------------------------------------------------
// assertExplanationSafe
// ---------------------------------------------------------------------------

describe("assertExplanationSafe", () => {
  it("returns ok for a clean, short explanation", () => {
    const result = assertExplanationSafe("Case passed as expected.");
    expect(result.isOk()).toBe(true);
  });

  it("returns err with ExplanationTooLong for overlong text", () => {
    const result = assertExplanationSafe("A".repeat(EXPLANATION_MAX_CHARS + 1));
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ExplanationTooLong");
  });

  it("returns err with ExplanationForbiddenPattern for <thinking>", () => {
    const result = assertExplanationSafe("<thinking>...</thinking>");
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ExplanationForbiddenPattern");
  });

  it("returns err with ExplanationForbiddenPattern for transcript role marker", () => {
    const result = assertExplanationSafe("Start\nAssistant: reply");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("ExplanationForbiddenPattern");
  });

  it("returns err for rationale: marker", () => {
    const result = assertExplanationSafe("rationale: the model was correct");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("ExplanationForbiddenPattern");
  });

  it("error message includes the context string", () => {
    const result = assertExplanationSafe(
      "A".repeat(EXPLANATION_MAX_CHARS + 1),
      "suite-summary-explanation",
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain(
      "suite-summary-explanation",
    );
  });

  it("accepts explanation at exactly EXPLANATION_MAX_CHARS", () => {
    const result = assertExplanationSafe("A".repeat(EXPLANATION_MAX_CHARS));
    expect(result.isOk()).toBe(true);
  });

  it("returns ok for empty string (length check only; empty passes pattern guards)", () => {
    // Empty strings pass forbidden-pattern checks since no pattern matches empty
    // (length guard only fires for strings OVER the limit).
    const result = assertExplanationSafe("");
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// truncateExplanation then buildExplanation round-trip
// ---------------------------------------------------------------------------

describe("truncateExplanation + buildExplanation round-trip", () => {
  it("truncated clean text produces a valid BoundedExplanation", () => {
    const longText = "Clean explanation. ".repeat(30); // well over 300 chars
    const truncated = truncateExplanation(longText);
    expect(truncated.length).toBe(EXPLANATION_MAX_CHARS);
    const result = buildExplanation(truncated, "operator_note", "human_review");
    expect(result.isOk()).toBe(true);
  });

  it("truncating does not introduce forbidden patterns for clean text", () => {
    const longText = "A".repeat(EXPLANATION_MAX_CHARS + 200);
    const truncated = truncateExplanation(longText);
    const safeResult = assertExplanationSafe(truncated);
    expect(safeResult.isOk()).toBe(true);
  });
});
