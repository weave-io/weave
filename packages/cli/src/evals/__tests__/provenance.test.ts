/**
 * Tests for `provenance.ts`.
 *
 * Verifies:
 *   - `deriveSummary()` produces a sanitized, human-readable summary that
 *     contains no raw prompt text.
 *   - `deriveProvenanceRecord()` produces a record with correct fields, no
 *     raw prompt, and the injected git SHA.
 *   - `buildManifest()` assembles a versioned manifest with all records.
 *   - `deriveProvenanceManifest()` resolves the git SHA via the injected
 *     provider and derives all records.
 *   - Published records reference hashes and summaries only.
 *   - `writeManifest()` writes valid JSON to a temp file.
 *   - `deriveAndWriteManifest()` combines derivation and writing.
 *   - The same snapshot input always yields the same hash in the record.
 *
 * Test isolation:
 *   - All tests inject a `MockGitShaProvider` — no git subprocess calls.
 *   - File writes target the Bun temp directory.
 *   - No network, shell, or harness calls are made.
 *   - Timestamps are injected for deterministic output.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";
import {
  buildManifest,
  deriveAndWriteManifest,
  deriveProvenanceManifest,
  deriveProvenanceRecord,
  deriveSummary,
  type GitShaProvider,
  writeManifest,
} from "../provenance.js";
import type {
  PromptProvenanceManifest,
  PromptSnapshot,
  ProvenanceError,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMP_DIR = tmpdir();

let _counter = 0;
function uid(): string {
  return String(Date.now()) + String(++_counter);
}

/** A mock GitShaProvider that returns a fixed SHA. */
function mockGitShaProvider(sha: string): GitShaProvider {
  return {
    resolveGitSha(): Result<string, ProvenanceError> {
      return ok(sha);
    },
  };
}

/** A mock GitShaProvider that always fails. */
function failingGitShaProvider(message: string): GitShaProvider {
  return {
    resolveGitSha(): Result<string, ProvenanceError> {
      return err({
        type: "GitShaResolutionError",
        message,
      });
    },
  };
}

/** Build a minimal `PromptSnapshot` for testing. */
function makeSnapshot(overrides: Partial<PromptSnapshot> = {}): PromptSnapshot {
  return {
    agentName: "loom",
    hash: "a".repeat(64),
    byteLength: 1024,
    charLength: 1000,
    sources: [{ kind: "builtin", layer: "primary" }],
    ...overrides,
  };
}

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const FIXED_SHA = "abc123def456abc123def456abc123def456abc1";

// ---------------------------------------------------------------------------
// deriveSummary
// ---------------------------------------------------------------------------

describe("deriveSummary", () => {
  it("includes the agent name in the summary", () => {
    const snapshot = makeSnapshot({ agentName: "tapestry" });
    const summary = deriveSummary(snapshot);
    expect(summary).toContain("tapestry");
  });

  it("includes the source count and kinds in the summary", () => {
    const snapshot = makeSnapshot({
      sources: [
        { kind: "builtin", layer: "primary" },
        { kind: "builtin", layer: "append" },
      ],
    });
    const summary = deriveSummary(snapshot);
    expect(summary).toContain("2 source(s)");
    expect(summary).toContain("builtin primary");
    expect(summary).toContain("builtin append");
  });

  it("includes the hash prefix (first 12 chars) in the summary", () => {
    const hash = `deadbeef${"0".repeat(56)}`;
    const snapshot = makeSnapshot({ hash });
    const summary = deriveSummary(snapshot);
    expect(summary).toContain("sha256:deadbeef0000");
  });

  it("includes character and byte lengths in the summary", () => {
    const snapshot = makeSnapshot({ charLength: 4321, byteLength: 4567 });
    const summary = deriveSummary(snapshot);
    expect(summary).toContain("4321 chars");
    expect(summary).toContain("4567 bytes");
  });

  it("does not include raw prompt content in the summary", () => {
    const snapshot = makeSnapshot({
      agentName: "loom",
      charLength: 100,
      byteLength: 100,
    });
    const summary = deriveSummary(snapshot);
    // Summary must not contain any hint of raw content
    // (we verify that common prompt phrases are absent — the hash prefix
    // is the only prompt-derived string, and it's obfuscated)
    expect(summary).not.toContain("You are");
    expect(summary).not.toContain("orchestrator");
    expect(summary).not.toContain("delegate");
  });

  it("summary is a non-empty string", () => {
    const summary = deriveSummary(makeSnapshot());
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
  });

  it("inline source kind appears in summary", () => {
    const snapshot = makeSnapshot({
      sources: [{ kind: "inline", layer: "primary" }],
    });
    const summary = deriveSummary(snapshot);
    expect(summary).toContain("inline");
  });

  it("file source kind appears in summary", () => {
    const snapshot = makeSnapshot({
      sources: [{ kind: "file", layer: "primary", filePath: "/some/path.md" }],
    });
    const summary = deriveSummary(snapshot);
    expect(summary).toContain("file");
  });

  it("generated source kind appears in summary", () => {
    const snapshot = makeSnapshot({
      sources: [{ kind: "generated", layer: "primary" }],
    });
    const summary = deriveSummary(snapshot);
    expect(summary).toContain("generated");
  });
});

// ---------------------------------------------------------------------------
// deriveProvenanceRecord
// ---------------------------------------------------------------------------

describe("deriveProvenanceRecord", () => {
  it("record has the correct agentName", () => {
    const snapshot = makeSnapshot({ agentName: "tapestry" });
    const record = deriveProvenanceRecord(snapshot, FIXED_SHA, FIXED_TIMESTAMP);
    expect(record.agentName).toBe("tapestry");
  });

  it("record hash matches snapshot hash", () => {
    const hash = "f".repeat(64);
    const snapshot = makeSnapshot({ hash });
    const record = deriveProvenanceRecord(snapshot, FIXED_SHA, FIXED_TIMESTAMP);
    expect(record.hash).toBe(hash);
  });

  it("record byteLength matches snapshot byteLength", () => {
    const snapshot = makeSnapshot({ byteLength: 2048 });
    const record = deriveProvenanceRecord(snapshot, FIXED_SHA, FIXED_TIMESTAMP);
    expect(record.byteLength).toBe(2048);
  });

  it("record charLength matches snapshot charLength", () => {
    const snapshot = makeSnapshot({ charLength: 1999 });
    const record = deriveProvenanceRecord(snapshot, FIXED_SHA, FIXED_TIMESTAMP);
    expect(record.charLength).toBe(1999);
  });

  it("record sources matches snapshot sources", () => {
    const sources = [
      { kind: "builtin" as const, layer: "primary" as const },
      { kind: "inline" as const, layer: "append" as const },
    ];
    const snapshot = makeSnapshot({ sources });
    const record = deriveProvenanceRecord(snapshot, FIXED_SHA, FIXED_TIMESTAMP);
    expect(record.sources).toEqual(sources);
  });

  it("record gitSha matches injected SHA", () => {
    const snapshot = makeSnapshot();
    const record = deriveProvenanceRecord(snapshot, FIXED_SHA, FIXED_TIMESTAMP);
    expect(record.gitSha).toBe(FIXED_SHA);
  });

  it("record capturedAt matches injected timestamp", () => {
    const snapshot = makeSnapshot();
    const record = deriveProvenanceRecord(snapshot, FIXED_SHA, FIXED_TIMESTAMP);
    expect(record.capturedAt).toBe(FIXED_TIMESTAMP);
  });

  it("record summary is a non-empty string", () => {
    const snapshot = makeSnapshot();
    const record = deriveProvenanceRecord(snapshot, FIXED_SHA, FIXED_TIMESTAMP);
    expect(typeof record.summary).toBe("string");
    expect(record.summary.length).toBeGreaterThan(0);
  });

  it("record does NOT contain raw prompt text", () => {
    const snapshot = makeSnapshot();
    const record = deriveProvenanceRecord(snapshot, FIXED_SHA, FIXED_TIMESTAMP);
    // These fields must not exist on the publishable record
    expect("composedPrompt" in record).toBe(false);
    expect("prompt" in record).toBe(false);
    expect("rawPrompt" in record).toBe(false);
    expect("text" in record).toBe(false);
  });

  it("same snapshot always yields the same hash in the record", () => {
    const snapshot = makeSnapshot({ hash: `1234${"a".repeat(60)}` });
    const record1 = deriveProvenanceRecord(
      snapshot,
      FIXED_SHA,
      FIXED_TIMESTAMP,
    );
    const record2 = deriveProvenanceRecord(
      snapshot,
      FIXED_SHA,
      FIXED_TIMESTAMP,
    );
    expect(record1.hash).toBe(record2.hash);
  });

  it("different hashes produce different records", () => {
    const snap1 = makeSnapshot({ hash: "a".repeat(64) });
    const snap2 = makeSnapshot({ hash: "b".repeat(64) });
    const rec1 = deriveProvenanceRecord(snap1, FIXED_SHA, FIXED_TIMESTAMP);
    const rec2 = deriveProvenanceRecord(snap2, FIXED_SHA, FIXED_TIMESTAMP);
    expect(rec1.hash).not.toBe(rec2.hash);
  });

  it("record summary contains the hash prefix", () => {
    const hash = `cafebabe${"0".repeat(56)}`;
    const snapshot = makeSnapshot({ hash });
    const record = deriveProvenanceRecord(snapshot, FIXED_SHA, FIXED_TIMESTAMP);
    expect(record.summary).toContain("cafebabe");
  });
});

// ---------------------------------------------------------------------------
// buildManifest
// ---------------------------------------------------------------------------

describe("buildManifest", () => {
  it("manifest has version 1", () => {
    const manifest = buildManifest([], FIXED_SHA, FIXED_TIMESTAMP);
    expect(manifest.version).toBe(1);
  });

  it("manifest producedAt matches injected timestamp", () => {
    const manifest = buildManifest([], FIXED_SHA, FIXED_TIMESTAMP);
    expect(manifest.producedAt).toBe(FIXED_TIMESTAMP);
  });

  it("manifest gitSha matches injected SHA", () => {
    const manifest = buildManifest([], FIXED_SHA, FIXED_TIMESTAMP);
    expect(manifest.gitSha).toBe(FIXED_SHA);
  });

  it("manifest records array matches injected records", () => {
    const snap = makeSnapshot({ agentName: "loom" });
    const record = deriveProvenanceRecord(snap, FIXED_SHA, FIXED_TIMESTAMP);
    const manifest = buildManifest([record], FIXED_SHA, FIXED_TIMESTAMP);
    expect(manifest.records).toHaveLength(1);
    expect(manifest.records[0]?.agentName).toBe("loom");
  });

  it("manifest with empty records array is valid", () => {
    const manifest = buildManifest([], FIXED_SHA, FIXED_TIMESTAMP);
    expect(manifest.records).toHaveLength(0);
  });

  it("manifest contains no raw prompt text across all records", () => {
    const records = [
      deriveProvenanceRecord(
        makeSnapshot({ agentName: "loom" }),
        FIXED_SHA,
        FIXED_TIMESTAMP,
      ),
      deriveProvenanceRecord(
        makeSnapshot({ agentName: "tapestry" }),
        FIXED_SHA,
        FIXED_TIMESTAMP,
      ),
    ];
    const manifest = buildManifest(records, FIXED_SHA, FIXED_TIMESTAMP);
    const manifestJson = JSON.stringify(manifest);
    // No raw prompt content fields present in serialized manifest
    expect(manifestJson).not.toContain('"composedPrompt"');
    expect(manifestJson).not.toContain('"rawPrompt"');
  });
});

// ---------------------------------------------------------------------------
// deriveProvenanceManifest
// ---------------------------------------------------------------------------

describe("deriveProvenanceManifest", () => {
  it("returns ok(manifest) with injected git SHA", () => {
    const snapshots = [makeSnapshot({ agentName: "loom" })];
    const result = deriveProvenanceManifest(snapshots, {
      gitShaProvider: mockGitShaProvider(FIXED_SHA),
      capturedAt: FIXED_TIMESTAMP,
    });
    expect(result.isOk()).toBe(true);
    const manifest = result._unsafeUnwrap();
    expect(manifest.gitSha).toBe(FIXED_SHA);
  });

  it("records in manifest use the injected git SHA", () => {
    const snapshots = [
      makeSnapshot({ agentName: "loom" }),
      makeSnapshot({ agentName: "tapestry", hash: "b".repeat(64) }),
    ];
    const result = deriveProvenanceManifest(snapshots, {
      gitShaProvider: mockGitShaProvider(FIXED_SHA),
      capturedAt: FIXED_TIMESTAMP,
    });
    expect(result.isOk()).toBe(true);
    for (const record of result._unsafeUnwrap().records) {
      expect(record.gitSha).toBe(FIXED_SHA);
    }
  });

  it("returns err when GitShaProvider fails", () => {
    const snapshots = [makeSnapshot()];
    const result = deriveProvenanceManifest(snapshots, {
      gitShaProvider: failingGitShaProvider("git not available"),
    });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("GitShaResolutionError");
  });

  it('uses "unknown" when provider returns "unknown"', () => {
    const snapshots = [makeSnapshot()];
    const result = deriveProvenanceManifest(snapshots, {
      gitShaProvider: mockGitShaProvider("unknown"),
      capturedAt: FIXED_TIMESTAMP,
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().gitSha).toBe("unknown");
  });

  it("manifest has the correct number of records", () => {
    const snapshots = [
      makeSnapshot({ agentName: "loom" }),
      makeSnapshot({ agentName: "tapestry", hash: "b".repeat(64) }),
    ];
    const result = deriveProvenanceManifest(snapshots, {
      gitShaProvider: mockGitShaProvider(FIXED_SHA),
      capturedAt: FIXED_TIMESTAMP,
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().records).toHaveLength(2);
  });

  it("records reference only hash + summary, not raw content", () => {
    const snapshots = [makeSnapshot({ agentName: "loom" })];
    const result = deriveProvenanceManifest(snapshots, {
      gitShaProvider: mockGitShaProvider(FIXED_SHA),
      capturedAt: FIXED_TIMESTAMP,
    });
    expect(result.isOk()).toBe(true);
    const manifest = result._unsafeUnwrap();
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain('"composedPrompt"');
    expect(serialized).not.toContain('"rawPrompt"');
    expect(serialized).not.toContain('"prompt":');
  });

  it("manifest producedAt uses injected capturedAt", () => {
    const snapshots = [makeSnapshot()];
    const result = deriveProvenanceManifest(snapshots, {
      gitShaProvider: mockGitShaProvider(FIXED_SHA),
      capturedAt: FIXED_TIMESTAMP,
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().producedAt).toBe(FIXED_TIMESTAMP);
  });

  it("empty snapshots array produces manifest with no records", () => {
    const result = deriveProvenanceManifest([], {
      gitShaProvider: mockGitShaProvider(FIXED_SHA),
      capturedAt: FIXED_TIMESTAMP,
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().records).toHaveLength(0);
  });

  it("same snapshots always produce same manifest structure", () => {
    const snapshots = [makeSnapshot({ agentName: "loom" })];
    const opts = {
      gitShaProvider: mockGitShaProvider(FIXED_SHA),
      capturedAt: FIXED_TIMESTAMP,
    };
    const result1 = deriveProvenanceManifest(snapshots, opts);
    const result2 = deriveProvenanceManifest(snapshots, opts);

    expect(result1.isOk()).toBe(true);
    expect(result2.isOk()).toBe(true);
    expect(JSON.stringify(result1._unsafeUnwrap())).toBe(
      JSON.stringify(result2._unsafeUnwrap()),
    );
  });
});

// ---------------------------------------------------------------------------
// writeManifest
// ---------------------------------------------------------------------------

describe("writeManifest", () => {
  it("writes valid JSON to disk", async () => {
    const manifest: PromptProvenanceManifest = buildManifest(
      [
        deriveProvenanceRecord(
          makeSnapshot({ agentName: "loom" }),
          FIXED_SHA,
          FIXED_TIMESTAMP,
        ),
      ],
      FIXED_SHA,
      FIXED_TIMESTAMP,
    );

    const filePath = resolve(TEMP_DIR, `provenance-manifest-${uid()}.json`);
    const result = await writeManifest(manifest, filePath);
    expect(result.isOk()).toBe(true);

    const written = await Bun.file(filePath).json();
    expect(written.version).toBe(1);
    expect(written.gitSha).toBe(FIXED_SHA);
    expect(Array.isArray(written.records)).toBe(true);
  });

  it("written JSON contains hash and summary for each record", async () => {
    const hash = `deadbeef${"0".repeat(56)}`;
    const manifest: PromptProvenanceManifest = buildManifest(
      [
        deriveProvenanceRecord(
          makeSnapshot({ agentName: "tapestry", hash }),
          FIXED_SHA,
          FIXED_TIMESTAMP,
        ),
      ],
      FIXED_SHA,
      FIXED_TIMESTAMP,
    );

    const filePath = resolve(
      TEMP_DIR,
      `provenance-manifest-hash-${uid()}.json`,
    );
    await writeManifest(manifest, filePath);
    const written = await Bun.file(filePath).json();

    expect(written.records[0].hash).toBe(hash);
    expect(typeof written.records[0].summary).toBe("string");
    expect(written.records[0].summary.length).toBeGreaterThan(0);
  });

  it("written JSON does NOT contain raw prompt text", async () => {
    const manifest: PromptProvenanceManifest = buildManifest(
      [
        deriveProvenanceRecord(
          makeSnapshot({ agentName: "loom" }),
          FIXED_SHA,
          FIXED_TIMESTAMP,
        ),
      ],
      FIXED_SHA,
      FIXED_TIMESTAMP,
    );

    const filePath = resolve(
      TEMP_DIR,
      `provenance-manifest-no-raw-${uid()}.json`,
    );
    await writeManifest(manifest, filePath);

    const content = await Bun.file(filePath).text();
    expect(content).not.toContain("composedPrompt");
    expect(content).not.toContain("rawPrompt");
  });

  it("returns ManifestWriteError when path is invalid", async () => {
    const manifest: PromptProvenanceManifest = buildManifest(
      [],
      FIXED_SHA,
      FIXED_TIMESTAMP,
    );

    const result = await writeManifest(manifest, tmpdir());
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ManifestWriteError");
    if (error.type === "ManifestWriteError") {
      expect(error.path).toBe(tmpdir());
      expect(error.message).toContain(tmpdir());
    }
  });
});

// ---------------------------------------------------------------------------
// deriveAndWriteManifest
// ---------------------------------------------------------------------------

describe("deriveAndWriteManifest", () => {
  it("derives and writes the manifest to disk", async () => {
    const snapshots = [makeSnapshot({ agentName: "loom" })];
    const filePath = resolve(TEMP_DIR, `daw-manifest-${uid()}.json`);

    const result = await deriveAndWriteManifest(snapshots, {
      gitShaProvider: mockGitShaProvider(FIXED_SHA),
      capturedAt: FIXED_TIMESTAMP,
      outputPath: filePath,
    });

    expect(result.isOk()).toBe(true);
    const written = await Bun.file(filePath).json();
    expect(written.version).toBe(1);
    expect(written.gitSha).toBe(FIXED_SHA);
  });

  it("returns the manifest on success", async () => {
    const snapshots = [
      makeSnapshot({ agentName: "loom" }),
      makeSnapshot({ agentName: "tapestry", hash: "b".repeat(64) }),
    ];
    const filePath = resolve(TEMP_DIR, `daw-manifest-return-${uid()}.json`);

    const result = await deriveAndWriteManifest(snapshots, {
      gitShaProvider: mockGitShaProvider(FIXED_SHA),
      capturedAt: FIXED_TIMESTAMP,
      outputPath: filePath,
    });

    expect(result.isOk()).toBe(true);
    const manifest = result._unsafeUnwrap();
    expect(manifest.records).toHaveLength(2);
    expect(manifest.gitSha).toBe(FIXED_SHA);
  });

  it("returns err when GitShaProvider fails (no file written)", async () => {
    const snapshots = [makeSnapshot()];
    const filePath = resolve(TEMP_DIR, `daw-manifest-err-${uid()}.json`);

    const result = await deriveAndWriteManifest(snapshots, {
      gitShaProvider: failingGitShaProvider("no git here"),
      capturedAt: FIXED_TIMESTAMP,
      outputPath: filePath,
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("GitShaResolutionError");
  });

  it("written manifest has no raw prompt content", async () => {
    const snapshots = [makeSnapshot({ agentName: "loom" })];
    const filePath = resolve(TEMP_DIR, `daw-no-raw-${uid()}.json`);

    await deriveAndWriteManifest(snapshots, {
      gitShaProvider: mockGitShaProvider(FIXED_SHA),
      capturedAt: FIXED_TIMESTAMP,
      outputPath: filePath,
    });

    const content = await Bun.file(filePath).text();
    expect(content).not.toContain("composedPrompt");
    expect(content).not.toContain("rawPrompt");
  });
});

// ---------------------------------------------------------------------------
// Hash-first contract: published manifests reference hashes prominently
// ---------------------------------------------------------------------------

describe("Hash-first contract", () => {
  it("hash is the first data field in the record after agentName", () => {
    const snapshot = makeSnapshot({ agentName: "loom", hash: "c".repeat(64) });
    const record = deriveProvenanceRecord(snapshot, FIXED_SHA, FIXED_TIMESTAMP);

    const keys = Object.keys(record);
    const agentNameIdx = keys.indexOf("agentName");
    const hashIdx = keys.indexOf("hash");

    // hash appears very early in the record (right after agentName)
    expect(hashIdx).toBeLessThan(5);
    expect(hashIdx).toBeGreaterThan(agentNameIdx);
  });

  it("summary is present and references the hash prefix", () => {
    const hash = `1234567890ab${"0".repeat(52)}`;
    const snapshot = makeSnapshot({ hash });
    const record = deriveProvenanceRecord(snapshot, FIXED_SHA, FIXED_TIMESTAMP);

    expect(record.summary).toContain("1234567890ab");
  });

  it("manifest JSON has hash before summary in each record", async () => {
    const manifest = buildManifest(
      [
        deriveProvenanceRecord(
          makeSnapshot({ hash: "a".repeat(64) }),
          FIXED_SHA,
          FIXED_TIMESTAMP,
        ),
      ],
      FIXED_SHA,
      FIXED_TIMESTAMP,
    );

    const json = JSON.stringify(manifest);
    const hashIdx = json.indexOf('"hash"');
    const summaryIdx = json.indexOf('"summary"');

    // hash appears before summary in the JSON output
    expect(hashIdx).toBeLessThan(summaryIdx);
  });
});
