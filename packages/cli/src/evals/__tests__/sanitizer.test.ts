/**
 * Tests for `sanitizer.ts`.
 *
 * Verifies:
 *   - Unknown fields in `CaseResultSummary` and `NormalizedScoreRecord` are dropped.
 *   - Sensitive subfields (tool args, env values, error payloads, log tails,
 *     rationales, raw content) are always excluded from sanitized output.
 *   - `assertPublishSafe()` rejects objects with sensitive fields.
 *   - `assertPublishSafe()` rejects objects containing `rawArtifact`.
 *   - `assertJsonPublishSafe()` rejects serialized JSON containing sensitive field names.
 *   - `dropUnknownFields()` retains only allowlisted fields.
 *   - Sanitized output is deterministic (same input → same output).
 *   - `sanitizeCaseResultSummary()` produces correct field values.
 *   - `sanitizeScoreRecord()` drops rationale from all dimensions.
 *   - `sanitizeProvenanceRecord()` keeps hash/summary/sources, no raw content.
 *   - `sanitizeProvenanceManifest()` sanitizes all records and manifest metadata.
 *   - `SENSITIVE_FIELD_NAMES` contains all expected sensitive fields.
 *
 * Test isolation:
 *   - No file I/O, network, git, or shell calls.
 *   - All fixtures are constructed inline.
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
  SENSITIVE_FIELD_NAMES,
  sanitizeCaseResultSummary,
  sanitizeProvenanceManifest,
  sanitizeProvenanceRecord,
  sanitizeScoreRecord,
  truncateExplanation,
} from "../sanitizer.js";
import type {
  CaseResultSummary,
  NormalizedScoreRecord,
  PromptProvenanceManifest,
  PromptProvenanceRecord,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeCaseResultSummary(
  overrides: Partial<CaseResultSummary> = {},
): CaseResultSummary {
  return {
    caseId: "route-to-shuttle",
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "loom-routing",
    passed: true,
    required: true,
    weightedTotal: 0.85,
    dimensionScores: {
      routingCorrectness: { score: 1.0, applicable: true },
      delegationCorrectness: { score: 1.0, applicable: false },
      executionCompleteness: { score: 1.0, applicable: false },
      rationaleQuality: { score: 0.8, applicable: true },
    },
    scoredAt: "2026-01-01T00:00:00.000Z",
    dryRun: false,
    ...overrides,
  };
}

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

function makeProvenanceRecord(
  overrides: Partial<PromptProvenanceRecord> = {},
): PromptProvenanceRecord {
  return {
    agentName: "loom",
    hash: "a".repeat(64),
    byteLength: 4096,
    charLength: 4000,
    sources: [{ kind: "builtin", layer: "primary" }],
    summary:
      'Agent "loom": 1 source(s) [builtin primary], hash sha256:aaaaaaaaaaaa…, 4000 chars, 4096 bytes',
    gitSha: "abc123def456abc123def456abc123def456abc1",
    capturedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProvenanceManifest(
  overrides: Partial<PromptProvenanceManifest> = {},
): PromptProvenanceManifest {
  return {
    version: 1,
    producedAt: "2026-01-01T00:00:00.000Z",
    gitSha: "abc123def456abc123def456abc123def456abc1",
    records: [makeProvenanceRecord()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SENSITIVE_FIELD_NAMES — blocklist completeness
// ---------------------------------------------------------------------------

describe("SENSITIVE_FIELD_NAMES", () => {
  it("contains composedPrompt", () => {
    expect(SENSITIVE_FIELD_NAMES.has("composedPrompt")).toBe(true);
  });

  it("contains rawContent", () => {
    expect(SENSITIVE_FIELD_NAMES.has("rawContent")).toBe(true);
  });

  it("contains rawPrompt", () => {
    expect(SENSITIVE_FIELD_NAMES.has("rawPrompt")).toBe(true);
  });

  it("contains rawArtifact", () => {
    expect(SENSITIVE_FIELD_NAMES.has("rawArtifact")).toBe(true);
  });

  it("contains rawArtifacts", () => {
    expect(SENSITIVE_FIELD_NAMES.has("rawArtifacts")).toBe(true);
  });

  it("contains transcript", () => {
    expect(SENSITIVE_FIELD_NAMES.has("transcript")).toBe(true);
  });

  it("contains rationale", () => {
    expect(SENSITIVE_FIELD_NAMES.has("rationale")).toBe(true);
  });

  it("contains dimensionRationales", () => {
    expect(SENSITIVE_FIELD_NAMES.has("dimensionRationales")).toBe(true);
  });

  it("contains toolArgs", () => {
    expect(SENSITIVE_FIELD_NAMES.has("toolArgs")).toBe(true);
  });

  it("contains env", () => {
    expect(SENSITIVE_FIELD_NAMES.has("env")).toBe(true);
  });

  it("contains cause", () => {
    expect(SENSITIVE_FIELD_NAMES.has("cause")).toBe(true);
  });

  it("contains body", () => {
    expect(SENSITIVE_FIELD_NAMES.has("body")).toBe(true);
  });

  it("contains logTail", () => {
    expect(SENSITIVE_FIELD_NAMES.has("logTail")).toBe(true);
  });

  it("contains prompt (raw text)", () => {
    expect(SENSITIVE_FIELD_NAMES.has("prompt")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REDACTED constant
// ---------------------------------------------------------------------------

describe("REDACTED", () => {
  it("is a recognizable sentinel string", () => {
    expect(REDACTED).toBe("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// sanitizeCaseResultSummary
// ---------------------------------------------------------------------------

describe("sanitizeCaseResultSummary", () => {
  it("retains caseId", () => {
    const summary = makeCaseResultSummary({ caseId: "my-case" });
    expect(sanitizeCaseResultSummary(summary).caseId).toBe("my-case");
  });

  it("retains modelId", () => {
    const summary = makeCaseResultSummary({ modelId: "openai/gpt-4o" });
    expect(sanitizeCaseResultSummary(summary).modelId).toBe("openai/gpt-4o");
  });

  it("retains suite", () => {
    const summary = makeCaseResultSummary({ suite: "tapestry-execution" });
    expect(sanitizeCaseResultSummary(summary).suite).toBe("tapestry-execution");
  });

  it("retains passed", () => {
    const summary = makeCaseResultSummary({ passed: false });
    expect(sanitizeCaseResultSummary(summary).passed).toBe(false);
  });

  it("retains required", () => {
    const summary = makeCaseResultSummary({ required: false });
    expect(sanitizeCaseResultSummary(summary).required).toBe(false);
  });

  it("retains weightedTotal", () => {
    const summary = makeCaseResultSummary({ weightedTotal: 0.42 });
    expect(sanitizeCaseResultSummary(summary).weightedTotal).toBeCloseTo(0.42);
  });

  it("retains scoredAt", () => {
    const ts = "2026-06-10T12:00:00.000Z";
    const summary = makeCaseResultSummary({ scoredAt: ts });
    expect(sanitizeCaseResultSummary(summary).scoredAt).toBe(ts);
  });

  it("retains dryRun", () => {
    const summary = makeCaseResultSummary({ dryRun: true });
    expect(sanitizeCaseResultSummary(summary).dryRun).toBe(true);
  });

  it("retains all four dimension scores", () => {
    const summary = makeCaseResultSummary();
    const sanitized = sanitizeCaseResultSummary(summary);
    const dims = sanitized.dimensionScores;
    expect(dims.routingCorrectness.score).toBe(1.0);
    expect(dims.delegationCorrectness.score).toBe(1.0);
    expect(dims.executionCompleteness.score).toBe(1.0);
    expect(dims.rationaleQuality.score).toBe(0.8);
  });

  it("retains applicable flags in dimensionScores", () => {
    const summary = makeCaseResultSummary();
    const sanitized = sanitizeCaseResultSummary(summary);
    expect(sanitized.dimensionScores.routingCorrectness.applicable).toBe(true);
    expect(sanitized.dimensionScores.delegationCorrectness.applicable).toBe(
      false,
    );
  });

  it("drops unknown top-level fields", () => {
    // Cast to any to add extra fields simulating future additions
    const summary = makeCaseResultSummary();
    (summary as unknown as Record<string, unknown>).unknownField =
      "should-be-dropped";

    const sanitized = sanitizeCaseResultSummary(summary);
    expect("unknownField" in sanitized).toBe(false);
  });

  it("output does not contain raw prompt text", () => {
    const summary = makeCaseResultSummary();
    const sanitized = sanitizeCaseResultSummary(summary);
    const json = JSON.stringify(sanitized);
    expect(json).not.toContain("composedPrompt");
    expect(json).not.toContain("rawContent");
    expect(json).not.toContain('"transcript"');
    // "rationaleQuality" is a dimension name and is allowed;
    // the literal field name "rationale" (with colon) must not appear
    expect(json).not.toContain('"rationale":');
  });

  it("is deterministic for identical inputs", () => {
    const summary = makeCaseResultSummary();
    const s1 = JSON.stringify(sanitizeCaseResultSummary(summary));
    const s2 = JSON.stringify(sanitizeCaseResultSummary(summary));
    expect(s1).toBe(s2);
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
// sanitizeProvenanceRecord
// ---------------------------------------------------------------------------

describe("sanitizeProvenanceRecord", () => {
  it("retains agentName", () => {
    const record = makeProvenanceRecord({ agentName: "tapestry" });
    expect(sanitizeProvenanceRecord(record).agentName).toBe("tapestry");
  });

  it("retains hash", () => {
    const hash = "b".repeat(64);
    const record = makeProvenanceRecord({ hash });
    expect(sanitizeProvenanceRecord(record).hash).toBe(hash);
  });

  it("retains byteLength and charLength", () => {
    const record = makeProvenanceRecord({ byteLength: 8192, charLength: 8000 });
    const sanitized = sanitizeProvenanceRecord(record);
    expect(sanitized.byteLength).toBe(8192);
    expect(sanitized.charLength).toBe(8000);
  });

  it("retains summary", () => {
    const record = makeProvenanceRecord({ summary: "Agent test summary" });
    expect(sanitizeProvenanceRecord(record).summary).toBe("Agent test summary");
  });

  it("retains gitSha", () => {
    const sha = `deadbeef${"0".repeat(32)}`;
    const record = makeProvenanceRecord({ gitSha: sha });
    expect(sanitizeProvenanceRecord(record).gitSha).toBe(sha);
  });

  it("retains capturedAt", () => {
    const ts = "2026-06-10T12:00:00.000Z";
    const record = makeProvenanceRecord({ capturedAt: ts });
    expect(sanitizeProvenanceRecord(record).capturedAt).toBe(ts);
  });

  it("retains sources", () => {
    const sources = [
      { kind: "builtin" as const, layer: "primary" as const },
      { kind: "inline" as const, layer: "append" as const },
    ];
    const record = makeProvenanceRecord({ sources });
    const sanitized = sanitizeProvenanceRecord(record);
    expect(sanitized.sources).toHaveLength(2);
    expect(sanitized.sources[0]?.kind).toBe("builtin");
  });

  it("does not contain raw prompt text fields", () => {
    const record = makeProvenanceRecord();
    const sanitized = sanitizeProvenanceRecord(record);
    expect("composedPrompt" in sanitized).toBe(false);
    expect("rawPrompt" in sanitized).toBe(false);
    expect("prompt" in sanitized).toBe(false);
  });

  it("serialized output contains no raw prompt fields", () => {
    const record = makeProvenanceRecord();
    const json = JSON.stringify(sanitizeProvenanceRecord(record));
    expect(json).not.toContain('"composedPrompt"');
    expect(json).not.toContain('"rawPrompt"');
  });

  it("is deterministic", () => {
    const record = makeProvenanceRecord();
    const s1 = JSON.stringify(sanitizeProvenanceRecord(record));
    const s2 = JSON.stringify(sanitizeProvenanceRecord(record));
    expect(s1).toBe(s2);
  });
});

// ---------------------------------------------------------------------------
// sanitizeProvenanceManifest
// ---------------------------------------------------------------------------

describe("sanitizeProvenanceManifest", () => {
  it("retains version", () => {
    const manifest = makeProvenanceManifest({ version: 2 });
    expect(sanitizeProvenanceManifest(manifest).version).toBe(2);
  });

  it("retains producedAt", () => {
    const ts = "2026-06-10T12:00:00.000Z";
    const manifest = makeProvenanceManifest({ producedAt: ts });
    expect(sanitizeProvenanceManifest(manifest).producedAt).toBe(ts);
  });

  it("retains gitSha", () => {
    const sha = `cafe${"0".repeat(36)}`;
    const manifest = makeProvenanceManifest({ gitSha: sha });
    expect(sanitizeProvenanceManifest(manifest).gitSha).toBe(sha);
  });

  it("sanitizes all records", () => {
    const manifest = makeProvenanceManifest({
      records: [
        makeProvenanceRecord({ agentName: "loom" }),
        makeProvenanceRecord({ agentName: "tapestry", hash: "b".repeat(64) }),
      ],
    });
    const sanitized = sanitizeProvenanceManifest(manifest);
    expect(sanitized.records).toHaveLength(2);
    expect(sanitized.records[0]?.agentName).toBe("loom");
    expect(sanitized.records[1]?.agentName).toBe("tapestry");
  });

  it("serialized manifest contains no raw prompt content", () => {
    const manifest = makeProvenanceManifest();
    const json = JSON.stringify(sanitizeProvenanceManifest(manifest));
    expect(json).not.toContain('"composedPrompt"');
    expect(json).not.toContain('"rawPrompt"');
    expect(json).not.toContain('"prompt":');
  });

  it("is deterministic", () => {
    const manifest = makeProvenanceManifest();
    const s1 = JSON.stringify(sanitizeProvenanceManifest(manifest));
    const s2 = JSON.stringify(sanitizeProvenanceManifest(manifest));
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
// End-to-end: sanitize then assertPublishSafe
// ---------------------------------------------------------------------------

describe("sanitize then assertPublishSafe (round-trip)", () => {
  it("sanitized CaseResultSummary passes assertPublishSafe", () => {
    const summary = makeCaseResultSummary();
    const sanitized = sanitizeCaseResultSummary(summary);
    const result = assertPublishSafe(
      sanitized as unknown as Record<string, unknown>,
    );
    expect(result.isOk()).toBe(true);
  });

  it("sanitized ScoreRecord passes assertPublishSafe", () => {
    const record = makeNormalizedScoreRecord();
    const sanitized = sanitizeScoreRecord(record);
    const result = assertPublishSafe(
      sanitized as unknown as Record<string, unknown>,
    );
    expect(result.isOk()).toBe(true);
  });

  it("sanitized CaseResultSummary passes assertJsonPublishSafe", () => {
    const summary = makeCaseResultSummary();
    const sanitized = sanitizeCaseResultSummary(summary);
    const json = JSON.stringify(sanitized);
    const result = assertJsonPublishSafe(json);
    expect(result.isOk()).toBe(true);
  });

  it("sanitized ScoreRecord passes assertJsonPublishSafe", () => {
    const record = makeNormalizedScoreRecord();
    const sanitized = sanitizeScoreRecord(record);
    const json = JSON.stringify(sanitized);
    const result = assertJsonPublishSafe(json);
    expect(result.isOk()).toBe(true);
  });

  it("sanitized ProvenanceManifest passes assertJsonPublishSafe", () => {
    const manifest = makeProvenanceManifest();
    const sanitized = sanitizeProvenanceManifest(manifest);
    const json = JSON.stringify(sanitized);
    const result = assertJsonPublishSafe(json);
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// localDiagnostic — blocked from publishable output
// ---------------------------------------------------------------------------

describe("SENSITIVE_FIELD_NAMES includes localDiagnostic", () => {
  it("SENSITIVE_FIELD_NAMES contains 'localDiagnostic'", () => {
    expect(SENSITIVE_FIELD_NAMES.has("localDiagnostic")).toBe(true);
  });

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
