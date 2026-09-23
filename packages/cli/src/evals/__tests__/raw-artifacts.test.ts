/**
 * Unit tests for `raw-artifacts.ts` — what a user cannot observe on disk.
 *
 * Raw artifacts are a local-only debugging output, and the promises about the
 * files they produce now live in
 * [`tests/evals/bundle-writing.scenario.test.ts`](../../../../../tests/evals/bundle-writing.scenario.test.ts):
 * that they land under the run's `raw/` subdirectory and nowhere else, that a
 * hostile case ID, model ID or agent name cannot escape it, that two writes a
 * millisecond apart keep both files, that the content a maintainer asked for
 * is actually in them, that nothing raw reaches a file the run declares
 * public, and that a disabled writer writes nothing.
 *
 * What stays here, and why:
 *
 *   - **`sanitizeFilenamePart()`** — a pure string helper whose interesting
 *     cases (an empty identifier, one made entirely of unsafe characters,
 *     leading dots) are not reachable from any real `caseId` or `modelId`, so
 *     no file on disk can demonstrate them.
 *   - **`MemoryFileWriter`** — a test double that ships in the source file.
 *     Its behaviour is not a product promise, but the remaining cases here
 *     depend on it, so it keeps its own coverage.
 *   - **The disabled-writer paths** for `writePromptArtifact()` and the batch
 *     method, which the scenario covers only for a single case artifact.
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
// RawArtifactsWriter — disabled mode
// ---------------------------------------------------------------------------

describe("RawArtifactsWriter (disabled)", () => {
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

describe("rawCaseResultFilename", () => {
  it("names a single-run case without an attempt", () => {
    expect(
      rawCaseResultFilename(
        "loom-route",
        "openai/gpt-5.5",
        "2026-09-23T06:01:43.182Z",
      ),
    ).toBe("case-loom-route-openai_gpt-5.5-2026-09-23T06-01-43-182Z.json");
  });

  it("puts the attempt in the name, so repeats written at one timestamp stay apart", () => {
    const first = rawCaseResultFilename(
      "loom-route",
      "openai/gpt-5.5",
      "2026-09-23T06:01:43.182Z",
      1,
    );
    const second = rawCaseResultFilename(
      "loom-route",
      "openai/gpt-5.5",
      "2026-09-23T06:01:43.182Z",
      2,
    );
    expect(first).toBe(
      "case-loom-route-openai_gpt-5.5-attempt1-2026-09-23T06-01-43-182Z.json",
    );
    expect(second).not.toBe(first);
  });
});
