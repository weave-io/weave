import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import {
  guardTrainExpiry,
  planStableCut,
  planStableFix,
  trainRecordDigest,
  transitionStableTrain,
  validateStableTrain,
} from "../stable-train.js";

const content = {
  schemaVersion: 1 as const,
  trainRef: "release/20260719-abcdef123456",
  subjectSha: "a".repeat(40),
  cutAt: "2026-07-19T00:00:00.000Z",
  expiresAt: "2026-07-26T00:00:00.000Z",
  state: "prepared" as const,
  packages: ["@weaveio/weave-cli"],
  versions: { "@weaveio/weave-cli": "1.2.3" },
};
const record = { ...content, recordDigest: trainRecordDigest(content) };

describe("stable train records", () => {
  it.each([
    ["canonical content-addressed record", record],
  ])("accepts %s", (_name, value) =>
    expect(validateStableTrain(value).isOk()).toBe(true));
  it.each([
    ["unknown schema", { ...record, schemaVersion: 2 }],
    [
      "missing digest binding",
      { ...record, recordDigest: `sha256:${"b".repeat(64)}` },
    ],
    [
      "nonseven-day expiry",
      { ...record, expiresAt: "2026-07-25T00:00:00.000Z" },
    ],
    [
      "Claude package",
      {
        ...record,
        packages: ["@weaveio/weave-adapter-claude-code"],
        versions: { "@weaveio/weave-adapter-claude-code": "1.2.3" },
      },
    ],
    ["extra property", { ...record, approval: true }],
  ])("rejects %s", (_name, value) =>
    expect(validateStableTrain(value).isErr()).toBe(true));

  it("permits only declared state transitions and redigests the record", () => {
    const result = transitionStableTrain(record as never, "built");
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.recordDigest).not.toBe(record.recordDigest);
    expect(transitionStableTrain(result.value, "finalized").isErr()).toBe(true);
  });
  it("creates an exact seven-day server cut and consumes stable files only", () => {
    const plan = planStableCut({
      mainHeadSha: "a".repeat(40),
      serverCutAt: new Date("2026-07-19T00:00:00.000Z"),
      partition: {
        stableFiles: [".changeset/stable.md"],
        remainOnMainFiles: [".changeset/claude.md", ".changeset/post-cut.md"],
      },
      changesets: [
        {
          path: ".changeset/stable.md",
          releases: new Map([["@weaveio/weave-cli", "minor"]]),
        },
      ],
      changesetContents: { ".changeset/stable.md": "stable bytes" },
      packageVersions: {
        "@weaveio/weave-cli": "1.0.0",
        "@weaveio/weave-adapter-opencode": "1.0.0",
        "@weaveio/weave-adapter-claude-code": "1.0.0",
      },
    });
    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) return;
    expect(plan.value.record.expiresAt).toBe("2026-07-26T00:00:00.000Z");
    expect(plan.value.worktree.consumedChangesets).toHaveLength(1);
    expect(plan.value.worktree.preservedPaths).toEqual([
      ".changeset/claude.md",
      ".changeset/post-cut.md",
    ]);
    expect(plan.value.record.packages).not.toContain(
      "@weaveio/weave-adapter-claude-code",
    );
  });
  it("rejects expired, non-main, and non-green stable fixes and invalidates artifacts", () => {
    const clock = {
      now: () => new Date("2026-07-20T00:00:00.000Z"),
      sleep: () => okAsync(undefined),
    };
    const withArtifacts = {
      ...record,
      artifactIds: [10],
      artifactManifestDigest: `sha256:${"c".repeat(64)}`,
    } as never;
    expect(
      planStableFix({
        record: withArtifacts,
        commits: [{ sha: "b".repeat(40), green: true, mergedToMain: false }],
        expectedHeadSha: "d".repeat(40),
        clock,
      }).isErr(),
    ).toBe(true);
    expect(
      planStableFix({
        record: withArtifacts,
        commits: [{ sha: "b".repeat(40), green: false, mergedToMain: true }],
        expectedHeadSha: "d".repeat(40),
        clock,
      }).isErr(),
    ).toBe(true);
    const fixed = planStableFix({
      record: withArtifacts,
      commits: [{ sha: "b".repeat(40), green: true, mergedToMain: true }],
      expectedHeadSha: "d".repeat(40),
      clock,
    });
    expect(fixed.isOk()).toBe(true);
    if (fixed.isOk()) expect(fixed.value.record.artifactIds).toBeUndefined();
    expect(
      guardTrainExpiry(record as never, {
        now: () => new Date("2026-07-26T00:00:00.000Z"),
        sleep: () => okAsync(undefined),
      }).isErr(),
    ).toBe(true);
  });
});
