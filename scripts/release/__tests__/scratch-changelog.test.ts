import { describe, expect, it } from "bun:test";
import {
  renderScratchChangelog,
  SCRATCH_CHANGELOG_BYTE_BUDGET,
} from "../scratch-changelog.js";

const input = {
  packageName: "@weaveio/weave-cli" as const,
  version: "0.1.0-next.20260818.abcdef123456",
  sourceSha: "a".repeat(40),
  canonicalNotesUrl: "https://github.com/weave-io/weave/releases",
  sourceHistory: [
    { sha: "b".repeat(40), subject: "add deterministic package staging" },
    { sha: "c".repeat(40), subject: "fix release inventory" },
  ],
  pendingChangesets: [
    { id: "release-inventory", sourceDigest: `sha256:${"d".repeat(64)}` },
  ],
};

describe("scratch changelog", () => {
  it("renders deterministic bounded content for every purpose", () => {
    for (const purpose of [
      "next",
      "nightly",
      "candidate-readiness",
      "bootstrap",
    ] as const) {
      const purposeInput = {
        ...input,
        purpose,
        version: purpose === "bootstrap" ? "0.0.0" : input.version,
      };
      const first = renderScratchChangelog(purposeInput);
      const second = renderScratchChangelog(purposeInput);
      expect(first.isOk()).toBe(true);
      expect(second.isOk()).toBe(true);
      if (first.isErr() || second.isErr()) continue;
      expect(first.value).toBe(second.value);
      expect(
        new TextEncoder().encode(first.value).byteLength,
      ).toBeLessThanOrEqual(SCRATCH_CHANGELOG_BYTE_BUDGET);
      expect(
        first.value.split("\n").slice(2).join("\n").trim().length,
      ).toBeGreaterThan(0);
      expect(first.value).toContain(input.packageName);
      expect(first.value).toContain(input.sourceSha);
      expect(first.value).toContain(input.canonicalNotesUrl);
      expect(first.value).toContain("release inventory");
      expect(first.value).toContain("release-inventory");
      expect(first.value).not.toContain("aiNotes");
    }
  });

  it("uses fixed channel notices, including the unsupported bootstrap notice", () => {
    const next = renderScratchChangelog({ ...input, purpose: "next" });
    const nightly = renderScratchChangelog({ ...input, purpose: "nightly" });
    const bootstrap = renderScratchChangelog({
      ...input,
      purpose: "bootstrap",
      version: "0.0.0",
    });
    expect(next.isOk() && next.value).toContain("prerelease");
    expect(nightly.isOk() && nightly.value).toContain("snapshot");
    expect(bootstrap.isOk() && bootstrap.value).toContain("unsupported");
    expect(bootstrap.isOk() && bootstrap.value).toContain("trusted publishing");
  });

  it("rejects invalid identity and oversized input with typed errors", () => {
    const invalid = renderScratchChangelog({
      ...input,
      purpose: "nightly",
      sourceSha: "not-a-sha",
    });
    expect(invalid.isErr()).toBe(true);
    if (invalid.isErr())
      expect(invalid.error).toEqual({
        type: "InvalidScratchChangelogInput",
        field: "sourceSha",
      });

    const oversized = renderScratchChangelog({
      ...input,
      purpose: "nightly",
      sourceHistory: [{ subject: "x" }],
      byteBudget: 128,
    });
    expect(oversized.isErr()).toBe(true);
    if (oversized.isErr())
      expect(oversized.error.type).toBe("ScratchChangelogTooLarge");
  });
});
