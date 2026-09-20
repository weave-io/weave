/**
 * Unit tests for `provenance.ts` — the parts that never reach a bundle.
 *
 * What a published run says about its prompts — a hash per agent, a hash that
 * moves when the prompt moves, the commit on the manifest and on every record,
 * and a summary naming each source layer without its text — is asserted
 * against the written `prompt-hashes.json` and `provenance-manifest.json` in
 * [`tests/evals/bundle-writing.scenario.test.ts`](../../../../../tests/evals/bundle-writing.scenario.test.ts).
 *
 * What stays here, and why:
 *
 *   - **`GitShaProvider` failure and the `"unknown"` fallback** — a hard SHA
 *     failure aborts before a bundle is ever written, so no file shows it.
 *   - **`writeManifest()` / `deriveAndWriteManifest()`** — a standalone
 *     manifest-to-disk API with no caller on the `weave eval` path; the runner
 *     uses `deriveProvenanceManifest()` and hands the result to the bundle
 *     writer. Its error path is reachable only from here.
 *   - **The hash-first record contract** — field order inside a record is a
 *     deliberate convention (`hash` before `summary`, so a diff leads with the
 *     hash) that the scenarios do not pin.
 *
 * Isolation: injected `GitShaProvider`, no git subprocess, no network.
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
// deriveProvenanceManifest
// ---------------------------------------------------------------------------

describe("deriveProvenanceManifest", () => {
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

  it("empty snapshots array produces manifest with no records", () => {
    const result = deriveProvenanceManifest([], {
      gitShaProvider: mockGitShaProvider(FIXED_SHA),
      capturedAt: FIXED_TIMESTAMP,
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().records).toHaveLength(0);
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
