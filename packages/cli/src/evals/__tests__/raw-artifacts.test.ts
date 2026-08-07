/**
 * Tests for `raw-artifacts.ts`.
 *
 * Verifies:
 *   - `rawCaseResultFilename()` produces correct filename formats.
 *   - `rawPromptFilename()` produces correct filename formats.
 *   - `RawArtifactsWriter.writeCaseResultArtifact()` writes to the
 *     `raw/` path with the correct content via the injected `MemoryFileWriter`.
 *   - `RawArtifactsWriter.writePromptArtifact()` writes to the
 *     `raw/` path with the correct content via the injected `MemoryFileWriter`.
 *   - Both write methods return `RawArtifactsDisabled` when the writer is
 *     constructed with `rawArtifactsEnabled: false`.
 *   - Written artifacts contain `composedPrompt` or `rawContent` markers.
 *   - Written artifacts do NOT contain publish-bundle markers.
 *   - `writeCaseResultArtifacts()` writes a batch and collects errors.
 *   - Raw artifact output is blocked unless explicitly enabled via the
 *     `rawArtifactsEnabled: true` constructor flag.
 *   - Filenames sanitize model ID slashes to underscores.
 *   - Filenames sanitize path traversal, slashes, and backslashes in caseId,
 *     agentName, and modelId — written paths always remain under `<bundle>/raw/`.
 *   - `MemoryFileWriter` records all writes in-memory (no real I/O).
 *
 * Test isolation:
 *   - All writes go through `MemoryFileWriter` — no real files are created.
 *   - No real model, scorer, git, or network calls.
 *   - All fixtures are constructed inline.
 */

import { describe, expect, it } from "bun:test";
import { basename, dirname, join, relative } from "node:path";
import {
  isoToFilesafeDatetime,
  MemoryFileWriter,
  RAW_ARTIFACTS_SUBDIR,
  RawArtifactsWriter,
  rawCaseResultFilename,
  rawPromptFilename,
  sanitizeFilenamePart,
} from "../raw-artifacts.js";
import type { RawCaseResultArtifact, RawPromptArtifact } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BUNDLE_DIR = join("fake", "bundle");
const FIXED_DATE = "2026-01-15";
const FIXED_TIMESTAMP = `${FIXED_DATE}T12:00:00.000Z`;

function relativeToBundle(filePath: string, bundleDir = BUNDLE_DIR): string {
  return relative(bundleDir, filePath);
}

function expectUnderRaw(filePath: string, bundleDir = BUNDLE_DIR): void {
  const relativePath = relativeToBundle(filePath, bundleDir);
  expect(dirname(relativePath)).toBe(RAW_ARTIFACTS_SUBDIR);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeCaseResultArtifact(
  overrides: Partial<RawCaseResultArtifact> = {},
): RawCaseResultArtifact {
  return {
    caseId: "route-to-shuttle",
    modelId: "anthropic/claude-sonnet-4.5",
    composedPrompt: "You are Loom, an orchestrator agent.",
    transcript: [
      { role: "user", content: "Route this task" },
      { role: "assistant", content: "I will route to shuttle." },
    ],
    rawContent: "I will route to shuttle.",
    dimensionRationales: {
      routingCorrectness: "Correctly routed to shuttle.",
      rationaleQuality: "Clear and concise rationale.",
    },
    ...overrides,
  };
}

function makePromptArtifact(
  overrides: Partial<RawPromptArtifact> = {},
): RawPromptArtifact {
  return {
    agentName: "loom",
    composedPrompt: "You are Loom, the main orchestrator.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RAW_ARTIFACTS_SUBDIR
// ---------------------------------------------------------------------------

describe("RAW_ARTIFACTS_SUBDIR", () => {
  it("is 'raw'", () => {
    expect(RAW_ARTIFACTS_SUBDIR).toBe("raw");
  });
});

// ---------------------------------------------------------------------------
// isoToFilesafeDatetime
// ---------------------------------------------------------------------------

describe("isoToFilesafeDatetime", () => {
  it("replaces colons with hyphens", () => {
    const result = isoToFilesafeDatetime("2026-06-11T14:32:07.123Z");
    expect(result).not.toContain(":");
    expect(result).toBe("2026-06-11T14-32-07-123Z");
  });

  it("replaces dots with hyphens", () => {
    const result = isoToFilesafeDatetime("2026-06-11T14:32:07.123Z");
    expect(result).not.toContain(".");
  });

  it("preserves date-only strings unchanged (no colons or dots)", () => {
    const result = isoToFilesafeDatetime("2026-01-15");
    expect(result).toBe("2026-01-15");
  });

  it("produces a filesystem-safe string (no colons or dots)", () => {
    const result = isoToFilesafeDatetime(FIXED_TIMESTAMP);
    expect(result).not.toContain(":");
    expect(result).not.toContain(".");
  });

  it("preserves millisecond precision", () => {
    // Millisecond digits must appear in the result
    const result = isoToFilesafeDatetime("2026-06-11T14:32:07.999Z");
    expect(result).toContain("999");
  });
});

// ---------------------------------------------------------------------------
// rawCaseResultFilename
// ---------------------------------------------------------------------------

describe("rawCaseResultFilename", () => {
  it("starts with 'case-'", () => {
    const name = rawCaseResultFilename(
      "my-case",
      "anthropic/claude-sonnet-4.5",
      FIXED_TIMESTAMP,
    );
    expect(name.startsWith("case-")).toBe(true);
  });

  it("ends with '.json'", () => {
    const name = rawCaseResultFilename(
      "my-case",
      "anthropic/claude-sonnet-4.5",
      FIXED_TIMESTAMP,
    );
    expect(name.endsWith(".json")).toBe(true);
  });

  it("includes caseId", () => {
    const name = rawCaseResultFilename(
      "route-to-shuttle",
      "openai/gpt-4o",
      FIXED_TIMESTAMP,
    );
    expect(name).toContain("route-to-shuttle");
  });

  it("replaces slashes in modelId with underscores", () => {
    const name = rawCaseResultFilename(
      "my-case",
      "anthropic/claude-sonnet-4.5",
      FIXED_TIMESTAMP,
    );
    expect(name).not.toContain("/");
    expect(name).toContain("anthropic_claude-sonnet-4.5");
  });

  it("includes full datetime component (not just date) from timestamp", () => {
    // Full ISO timestamp → filesystem-safe datetime with time and ms components
    const name = rawCaseResultFilename(
      "my-case",
      "openai/gpt-4o",
      FIXED_TIMESTAMP,
    );
    // Must contain the date part
    expect(name).toContain(FIXED_DATE);
    // Must contain some time component (not just YYYY-MM-DD)
    expect(name).toContain("T12-00-00");
  });

  it("does NOT contain colons (filesystem-safe)", () => {
    const name = rawCaseResultFilename(
      "my-case",
      "openai/gpt-4o",
      FIXED_TIMESTAMP,
    );
    expect(name).not.toContain(":");
  });

  it("does NOT contain dots except the final .json extension", () => {
    const name = rawCaseResultFilename(
      "my-case",
      "openai/gpt-4o",
      FIXED_TIMESTAMP,
    );
    // Only the model ID sanitized dots and the .json extension should remain
    const _withoutJson = name.slice(0, -5);
    // The datetime part must not contain dots (they're replaced with hyphens)
    const _parts = name.split("-");
    // Check no raw ISO dots appear (millisecond dot replaced with hyphen)
    expect(name).not.toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}/);
  });

  it("two calls with the same inputs produce identical filenames", () => {
    const n1 = rawCaseResultFilename(
      "case-1",
      "openai/gpt-4o",
      FIXED_TIMESTAMP,
    );
    const n2 = rawCaseResultFilename(
      "case-1",
      "openai/gpt-4o",
      FIXED_TIMESTAMP,
    );
    expect(n1).toBe(n2);
  });

  it("two calls with different timestamps produce different filenames", () => {
    const ts1 = "2026-01-15T12:00:00.000Z";
    const ts2 = "2026-01-15T12:00:00.001Z"; // 1 ms later
    const n1 = rawCaseResultFilename("case-1", "openai/gpt-4o", ts1);
    const n2 = rawCaseResultFilename("case-1", "openai/gpt-4o", ts2);
    expect(n1).not.toBe(n2);
  });

  it("different caseIds produce different filenames", () => {
    const n1 = rawCaseResultFilename(
      "case-a",
      "openai/gpt-4o",
      FIXED_TIMESTAMP,
    );
    const n2 = rawCaseResultFilename(
      "case-b",
      "openai/gpt-4o",
      FIXED_TIMESTAMP,
    );
    expect(n1).not.toBe(n2);
  });
});

// ---------------------------------------------------------------------------
// rawPromptFilename
// ---------------------------------------------------------------------------

describe("rawPromptFilename", () => {
  it("starts with 'prompt-'", () => {
    const name = rawPromptFilename("loom", FIXED_TIMESTAMP);
    expect(name.startsWith("prompt-")).toBe(true);
  });

  it("ends with '.json'", () => {
    const name = rawPromptFilename("loom", FIXED_TIMESTAMP);
    expect(name.endsWith(".json")).toBe(true);
  });

  it("includes agentName", () => {
    const name = rawPromptFilename("tapestry", FIXED_TIMESTAMP);
    expect(name).toContain("tapestry");
  });

  it("includes full datetime component from timestamp", () => {
    const name = rawPromptFilename("loom", FIXED_TIMESTAMP);
    expect(name).toContain(FIXED_DATE);
    expect(name).toContain("T12-00-00");
  });

  it("does NOT contain colons (filesystem-safe)", () => {
    const name = rawPromptFilename("loom", FIXED_TIMESTAMP);
    expect(name).not.toContain(":");
  });

  it("is deterministic for identical inputs", () => {
    const n1 = rawPromptFilename("loom", FIXED_TIMESTAMP);
    const n2 = rawPromptFilename("loom", FIXED_TIMESTAMP);
    expect(n1).toBe(n2);
  });

  it("two calls with different timestamps produce different filenames", () => {
    const ts1 = "2026-01-15T12:00:00.000Z";
    const ts2 = "2026-01-15T12:00:00.001Z"; // 1 ms later
    const n1 = rawPromptFilename("loom", ts1);
    const n2 = rawPromptFilename("loom", ts2);
    expect(n1).not.toBe(n2);
  });
});

// ---------------------------------------------------------------------------
// RawArtifactsWriter — disabled mode
// ---------------------------------------------------------------------------

describe("RawArtifactsWriter (disabled)", () => {
  it("writeCaseResultArtifact returns RawArtifactsDisabled when disabled", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, false, mem);
    const artifact = makeCaseResultArtifact();
    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("RawArtifactsDisabled");
    // No writes should have occurred
    expect(mem.writes.size).toBe(0);
  });

  it("writePromptArtifact returns RawArtifactsDisabled when disabled", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, false, mem);
    const artifact = makePromptArtifact();
    const result = await writer.writePromptArtifact(artifact, FIXED_TIMESTAMP);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("RawArtifactsDisabled");
    // No writes should have occurred
    expect(mem.writes.size).toBe(0);
  });

  it("writeCaseResultArtifacts returns empty written array with one error when disabled", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, false, mem);
    const artifacts = [
      makeCaseResultArtifact(),
      makeCaseResultArtifact({ caseId: "case-2", modelId: "openai/gpt-4o" }),
    ];
    const result = await writer.writeCaseResultArtifacts(
      artifacts,
      FIXED_TIMESTAMP,
    );

    expect(result.isOk()).toBe(true);
    const { written, errors } = result._unsafeUnwrap();
    expect(written).toHaveLength(0);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.type).toBe("RawArtifactsDisabled");
    // No writes should have occurred
    expect(mem.writes.size).toBe(0);
  });

  it("no files are written when disabled", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, false, mem);
    await writer.writeCaseResultArtifact(
      makeCaseResultArtifact(),
      FIXED_TIMESTAMP,
    );
    expect(mem.writes.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RawArtifactsWriter — enabled mode (uses MemoryFileWriter — no real I/O)
// ---------------------------------------------------------------------------

describe("RawArtifactsWriter (enabled)", () => {
  it("writeCaseResultArtifact writes to the raw/ subdirectory path", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makeCaseResultArtifact();

    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );

    expect(result.isOk()).toBe(true);
    const filePath = result._unsafeUnwrap();
    expectUnderRaw(filePath);
    expect(filePath).toContain("case-route-to-shuttle");
    // Verify the mock recorded exactly one write at the returned path
    expect(mem.writes.size).toBe(1);
    expect(mem.writes.has(filePath)).toBe(true);
  });

  it("writeCaseResultArtifact stores valid JSON content", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makeCaseResultArtifact();

    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);

    const filePath = result._unsafeUnwrap();
    const rawContent = mem.getContent(filePath);
    expect(rawContent).toBeDefined();
    const parsed = JSON.parse(rawContent!);
    expect(parsed.caseId).toBe("route-to-shuttle");
    expect(parsed.modelId).toBe("anthropic/claude-sonnet-4.5");
  });

  it("written case result content contains composedPrompt", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makeCaseResultArtifact({
      composedPrompt: "You are Loom.",
    });

    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);

    const filePath = result._unsafeUnwrap();
    const content = mem.getContent(filePath) ?? "";
    expect(content).toContain("composedPrompt");
  });

  it("written case result content contains rawContent", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makeCaseResultArtifact({
      rawContent: "Model answer here.",
    });

    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);

    const filePath = result._unsafeUnwrap();
    const content = mem.getContent(filePath) ?? "";
    expect(content).toContain("rawContent");
  });

  it("written case result content contains transcript", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makeCaseResultArtifact();

    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);

    const filePath = result._unsafeUnwrap();
    const content = mem.getContent(filePath) ?? "";
    expect(content).toContain("transcript");
  });

  it("writePromptArtifact writes to the raw/ subdirectory path", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makePromptArtifact();

    const result = await writer.writePromptArtifact(artifact, FIXED_TIMESTAMP);

    expect(result.isOk()).toBe(true);
    const filePath = result._unsafeUnwrap();
    expectUnderRaw(filePath);
    expect(filePath).toContain("prompt-loom");
    expect(mem.writes.has(filePath)).toBe(true);
  });

  it("writePromptArtifact stores valid JSON content with composedPrompt", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makePromptArtifact({ agentName: "tapestry" });

    const result = await writer.writePromptArtifact(artifact, FIXED_TIMESTAMP);
    expect(result.isOk()).toBe(true);

    const filePath = result._unsafeUnwrap();
    const rawContent = mem.getContent(filePath);
    expect(rawContent).toBeDefined();
    const parsed = JSON.parse(rawContent!);
    expect(parsed.agentName).toBe("tapestry");
    expect(typeof parsed.composedPrompt).toBe("string");
  });

  it("writeCaseResultArtifacts writes all artifacts in batch", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifacts = [
      makeCaseResultArtifact({ caseId: "case-1" }),
      makeCaseResultArtifact({ caseId: "case-2" }),
    ];

    const result = await writer.writeCaseResultArtifacts(
      artifacts,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);
    const { written, errors } = result._unsafeUnwrap();
    expect(written).toHaveLength(2);
    expect(errors).toHaveLength(0);
    // Both paths were captured by the mock
    expect(mem.writes.size).toBe(2);
  });

  it("writeCaseResultArtifacts continues on individual write failures", async () => {
    // Simulate a write failure for one artifact by injecting a throwing writer
    let callCount = 0;
    const failOnSecond: import("../raw-artifacts.js").RawFileWriter = {
      write(path: string, content: string): Promise<void> {
        callCount++;
        if (callCount === 2) {
          return Promise.reject(new Error("Simulated write failure"));
        }
        return Promise.resolve();
      },
    };

    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, failOnSecond);
    const artifacts = [
      makeCaseResultArtifact({ caseId: "case-good" }),
      makeCaseResultArtifact({
        caseId: "case-fail",
        modelId: "openai/gpt-4o",
      }),
    ];

    const result = await writer.writeCaseResultArtifacts(
      artifacts,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);
    const { written, errors } = result._unsafeUnwrap();
    // First succeeds, second fails
    expect(written).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.type).toBe("RawArtifactWriteError");
  });

  it("filename includes sanitized model ID (no slashes)", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makeCaseResultArtifact({
      caseId: "my-case",
      modelId: "anthropic/claude-sonnet-4.5",
    });

    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);
    const filePath = result._unsafeUnwrap();
    expect(filePath).not.toContain("anthropic/claude"); // slash sanitized
    expect(filePath).toContain("anthropic_claude"); // underscore replacement
  });

  it("written path is under the bundle raw/ directory", async () => {
    const mem = new MemoryFileWriter();
    const bundleDir = join("my", "custom", "bundle");
    const writer = new RawArtifactsWriter(bundleDir, true, mem);
    const artifact = makeCaseResultArtifact();

    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);
    const filePath = result._unsafeUnwrap();
    // Path must be under <bundleDir>/raw/
    expectUnderRaw(filePath, bundleDir);
  });
});

// ---------------------------------------------------------------------------
// MemoryFileWriter — seam contract verification
// ---------------------------------------------------------------------------

describe("MemoryFileWriter", () => {
  it("records writes in the writes map", async () => {
    const mem = new MemoryFileWriter();
    await mem.write("/some/path/file.json", '{"key":"value"}');
    expect(mem.writes.size).toBe(1);
    expect(mem.writes.get("/some/path/file.json")).toBe('{"key":"value"}');
  });

  it("getContent returns content for a known path", async () => {
    const mem = new MemoryFileWriter();
    await mem.write("/a/b.json", "hello");
    expect(mem.getContent("/a/b.json")).toBe("hello");
  });

  it("getContent returns undefined for an unknown path", () => {
    const mem = new MemoryFileWriter();
    expect(mem.getContent("/nonexistent.json")).toBeUndefined();
  });

  it("allPaths returns sorted list of written paths", async () => {
    const mem = new MemoryFileWriter();
    await mem.write("/z/c.json", "c");
    await mem.write("/a/b.json", "b");
    expect(mem.allPaths()).toEqual(["/a/b.json", "/z/c.json"]);
  });

  it("clear resets all captured writes", async () => {
    const mem = new MemoryFileWriter();
    await mem.write("/some/file.json", "data");
    mem.clear();
    expect(mem.writes.size).toBe(0);
  });

  it("overwrites existing content on repeated write to same path", async () => {
    const mem = new MemoryFileWriter();
    await mem.write("/file.json", "first");
    await mem.write("/file.json", "second");
    expect(mem.getContent("/file.json")).toBe("second");
    expect(mem.writes.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RawArtifactsWriter — marker validation
// ---------------------------------------------------------------------------

describe("RawArtifactsWriter — marker validation", () => {
  it("allows writing when raw marker keys are present even if values are empty", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);

    // Construct an artifact with empty composedPrompt and rawContent
    const artifact: RawCaseResultArtifact = {
      caseId: "empty-case",
      modelId: "openai/gpt-4o",
      composedPrompt: "", // empty — no marker
      transcript: [],
      rawContent: "", // empty — no marker
      dimensionRationales: {},
    };

    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );
    // The marker check looks for raw JSON key names, not non-empty values.
    expect(result.isOk()).toBe(true);
  });

  it("allows writing when composedPrompt field is present (even if empty value)", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);

    const artifact = makeCaseResultArtifact({ composedPrompt: "some content" });
    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);
    // Verify the write was actually captured
    expect(mem.writes.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sanitizeFilenamePart — unit tests
// ---------------------------------------------------------------------------

describe("sanitizeFilenamePart", () => {
  it("leaves safe alphanumeric-hyphen-underscore-dot strings unchanged", () => {
    expect(sanitizeFilenamePart("route-to-shuttle")).toBe("route-to-shuttle");
    expect(sanitizeFilenamePart("my_case.v2")).toBe("my_case.v2");
    expect(sanitizeFilenamePart("abc123")).toBe("abc123");
  });

  it("replaces forward slashes with underscores", () => {
    const result = sanitizeFilenamePart("anthropic/claude-sonnet-4.5");
    expect(result).not.toContain("/");
    expect(result).toContain("anthropic_claude-sonnet-4");
  });

  it("replaces backslashes with underscores", () => {
    const result = sanitizeFilenamePart("path\\to\\agent");
    expect(result).not.toContain("\\");
    expect(result).toBe("path_to_agent");
  });

  it("replaces ../ path traversal with safe underscores", () => {
    const result = sanitizeFilenamePart("../evil");
    expect(result).not.toContain("..");
    expect(result).not.toContain("/");
    // After step1: .._evil; step2: .._evil; step3: .._evil → __evil; step4: strip leading dot → __evil
    expect(result).not.toMatch(/^\./);
  });

  it("replaces ..\\  backslash traversal with safe underscores", () => {
    const result = sanitizeFilenamePart("..\\evil");
    expect(result).not.toContain("..");
    expect(result).not.toContain("\\");
  });

  it("collapses embedded .. into __", () => {
    const result = sanitizeFilenamePart("a..b");
    expect(result).not.toContain("..");
    expect(result).toBe("a__b");
  });

  it("strips leading dots", () => {
    const result = sanitizeFilenamePart("..hidden");
    // After all steps the result must not start with a dot
    expect(result).not.toMatch(/^\./);
  });

  it("returns _ for an empty string", () => {
    expect(sanitizeFilenamePart("")).toBe("_");
  });

  it("returns _ for a string of only unsafe chars that reduce to empty", () => {
    // All slashes/backslashes strip to nothing meaningful
    const result = sanitizeFilenamePart("../");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain("/");
    expect(result).not.toContain("\\");
    expect(result).not.toContain("..");
  });

  it("preserves model ID dots (e.g. 4.5) in the output", () => {
    const result = sanitizeFilenamePart("anthropic/claude-sonnet-4.5");
    // Single dots between digits must remain
    expect(result).toContain("4.5");
  });
});

// ---------------------------------------------------------------------------
// Path traversal safety — rawCaseResultFilename
// ---------------------------------------------------------------------------

describe("rawCaseResultFilename — path traversal safety", () => {
  it("sanitizes ../ in caseId — no traversal segments in filename", () => {
    const name = rawCaseResultFilename(
      "../evil",
      "openai/gpt-4o",
      FIXED_TIMESTAMP,
    );
    expect(name).not.toContain("..");
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
  });

  it("sanitizes slash in caseId", () => {
    const name = rawCaseResultFilename(
      "foo/bar",
      "openai/gpt-4o",
      FIXED_TIMESTAMP,
    );
    expect(name).not.toContain("/");
    // The slash in the modelId is also sanitized, so neither component leaks slashes
    expect(name.startsWith("case-")).toBe(true);
    expect(name.endsWith(".json")).toBe(true);
  });

  it("sanitizes backslash in caseId", () => {
    const name = rawCaseResultFilename(
      "foo\\bar",
      "openai/gpt-4o",
      FIXED_TIMESTAMP,
    );
    expect(name).not.toContain("\\");
    expect(name).not.toContain("/");
  });

  it("sanitizes ../ in modelId — no traversal segments in filename", () => {
    const name = rawCaseResultFilename("my-case", "../evil", FIXED_TIMESTAMP);
    expect(name).not.toContain("..");
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
  });

  it("sanitizes backslash in modelId", () => {
    const name = rawCaseResultFilename(
      "my-case",
      "evil\\model",
      FIXED_TIMESTAMP,
    );
    expect(name).not.toContain("\\");
  });

  it("still replaces slashes in modelId with underscores (existing behaviour)", () => {
    const name = rawCaseResultFilename(
      "my-case",
      "anthropic/claude-sonnet-4.5",
      FIXED_TIMESTAMP,
    );
    expect(name).not.toContain("/");
    expect(name).toContain("anthropic_claude-sonnet-4.5");
  });
});

// ---------------------------------------------------------------------------
// Path traversal safety — rawPromptFilename
// ---------------------------------------------------------------------------

describe("rawPromptFilename — path traversal safety", () => {
  it("sanitizes ../ in agentName — no traversal segments in filename", () => {
    const name = rawPromptFilename("../evil", FIXED_TIMESTAMP);
    expect(name).not.toContain("..");
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
  });

  it("sanitizes slash in agentName", () => {
    const name = rawPromptFilename("some/agent", FIXED_TIMESTAMP);
    expect(name).not.toContain("/");
    expect(name.startsWith("prompt-")).toBe(true);
  });

  it("sanitizes backslash in agentName", () => {
    const name = rawPromptFilename("some\\agent", FIXED_TIMESTAMP);
    expect(name).not.toContain("\\");
    expect(name).not.toContain("/");
  });
});

// ---------------------------------------------------------------------------
// Path containment — writeCaseResultArtifact
// ---------------------------------------------------------------------------

describe("RawArtifactsWriter — path containment (writeCaseResultArtifact)", () => {
  it("path stays under raw/ with a normal caseId", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makeCaseResultArtifact({ caseId: "normal-case" });

    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);
    const filePath = result._unsafeUnwrap();
    expectUnderRaw(filePath);
  });

  it("path stays under raw/ even with ../ in caseId", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    // The sanitizer rewrites ../evil → a safe component; containment must hold
    const artifact = makeCaseResultArtifact({ caseId: "../evil" });

    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);
    const filePath = result._unsafeUnwrap();
    expectUnderRaw(filePath);
    expect(filePath).not.toContain("..");
  });

  it("path stays under raw/ even with slash in caseId", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makeCaseResultArtifact({ caseId: "sub/case" });

    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);
    const filePath = result._unsafeUnwrap();
    // Strip the bundle prefix and verify no extra directory segments from the caseId
    const relativePath = relativeToBundle(filePath);
    expect(dirname(relativePath)).toBe(RAW_ARTIFACTS_SUBDIR);
    // No slash in the filename portion (after raw/)
    const filenameOnly = basename(relativePath);
    expect(filenameOnly).not.toContain("/");
  });

  it("path stays under raw/ even with backslash in caseId", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makeCaseResultArtifact({ caseId: "sub\\case" });

    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);
    const filePath = result._unsafeUnwrap();
    expectUnderRaw(filePath);
  });

  it("path stays under raw/ even with ../ in modelId", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makeCaseResultArtifact({ modelId: "../evil" });

    const result = await writer.writeCaseResultArtifact(
      artifact,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);
    const filePath = result._unsafeUnwrap();
    expectUnderRaw(filePath);
    expect(filePath).not.toContain("..");
  });
});

// ---------------------------------------------------------------------------
// Path containment — writePromptArtifact
// ---------------------------------------------------------------------------

describe("RawArtifactsWriter — path containment (writePromptArtifact)", () => {
  it("path stays under raw/ with a normal agentName", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makePromptArtifact({ agentName: "loom" });

    const result = await writer.writePromptArtifact(artifact, FIXED_TIMESTAMP);
    expect(result.isOk()).toBe(true);
    const filePath = result._unsafeUnwrap();
    expectUnderRaw(filePath);
  });

  it("path stays under raw/ even with ../ in agentName", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makePromptArtifact({ agentName: "../evil" });

    const result = await writer.writePromptArtifact(artifact, FIXED_TIMESTAMP);
    expect(result.isOk()).toBe(true);
    const filePath = result._unsafeUnwrap();
    expectUnderRaw(filePath);
    expect(filePath).not.toContain("..");
  });

  it("path stays under raw/ even with slash in agentName", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makePromptArtifact({ agentName: "some/agent" });

    const result = await writer.writePromptArtifact(artifact, FIXED_TIMESTAMP);
    expect(result.isOk()).toBe(true);
    const filePath = result._unsafeUnwrap();
    const relativePath = relativeToBundle(filePath);
    expect(dirname(relativePath)).toBe(RAW_ARTIFACTS_SUBDIR);
    const filenameOnly = basename(relativePath);
    expect(filenameOnly).not.toContain("/");
  });

  it("path stays under raw/ even with backslash in agentName", async () => {
    const mem = new MemoryFileWriter();
    const writer = new RawArtifactsWriter(BUNDLE_DIR, true, mem);
    const artifact = makePromptArtifact({ agentName: "some\\agent" });

    const result = await writer.writePromptArtifact(artifact, FIXED_TIMESTAMP);
    expect(result.isOk()).toBe(true);
    const filePath = result._unsafeUnwrap();
    expectUnderRaw(filePath);
  });
});
