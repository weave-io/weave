import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import { STABLE_TRAIN_STATES, STABLE_TRAIN_TRANSITIONS } from "../constants.js";
import type { StableTrainRecord } from "../model.js";
import type { StableTrainContent } from "../stable-train.js";
import {
  assertCurrentArtifactIdentity,
  bindStableTrain,
  guardTrainExpiry,
  partialPublishRecoveryMetadata,
  planStableCut,
  planStableFix,
  trainRecordDigest,
  transitionStableTrain,
  validateStableTrain,
} from "../stable-train.js";

function digestContent(content: StableTrainContent): string {
  const result = trainRecordDigest(content);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function checkedRecord(content: StableTrainContent): StableTrainRecord {
  const result = validateStableTrain({
    ...content,
    recordDigest: digestContent(content),
  });
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

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
const record = checkedRecord(content);

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

  it("formalizes the complete state × state transition matrix", () => {
    for (const from of STABLE_TRAIN_STATES)
      for (const to of STABLE_TRAIN_STATES) {
        const stateful = { ...content, state: from };
        const statefulRecord = checkedRecord(stateful);
        const result = transitionStableTrain(statefulRecord, to);
        const legal = STABLE_TRAIN_TRANSITIONS[from].some(
          (candidate) => candidate === to,
        );
        expect(result.isOk(), `${from} -> ${to}`).toBe(legal);
        if (result.isErr()) expect(result.error.type).toBe("InvalidTransition");
      }
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
        "@weaveio/weave-adapter-pi": "1.0.0",
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
      sleep: () => okAsync(),
    };
    const { recordDigest: _recordDigest, ...recordContent } = record;
    const withArtifacts = checkedRecord({
      ...recordContent,
      artifactIds: [10],
      artifactManifestDigest: `sha256:${"c".repeat(64)}`,
    });
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
      guardTrainExpiry(record, {
        now: () => new Date("2026-07-26T00:00:00.000Z"),
        sleep: () => okAsync(),
      }).isErr(),
    ).toBe(true);
  });
  it("rejects stale artifact identities from rebuilds and rerun attempts", () => {
    const { recordDigest: _recordDigest, ...recordContent } = record;
    const bound = checkedRecord({
      ...recordContent,
      artifactIds: [17],
      artifactManifestDigest: `sha256:${"c".repeat(64)}`,
    });
    expect(
      assertCurrentArtifactIdentity(
        bound,
        `sha256:${"c".repeat(64)}`,
        [17],
      ).isOk(),
    ).toBe(true);
    expect(
      assertCurrentArtifactIdentity(
        bound,
        `sha256:${"d".repeat(64)}`,
        [18],
      ).isErr(),
    ).toBe(true);
    const rebuilt = planStableFix({
      record: bound,
      commits: [{ sha: "b".repeat(40), green: true, mergedToMain: true }],
      expectedHeadSha: "d".repeat(40),
      clock: {
        now: () => new Date("2026-07-20T00:00:00.000Z"),
        sleep: () => okAsync(),
      },
    });
    expect(rebuilt.isOk()).toBe(true);
    if (rebuilt.isErr()) return;
    expect(
      assertCurrentArtifactIdentity(
        rebuilt.value.record,
        `sha256:${"c".repeat(64)}`,
        [17],
      ).isErr(),
    ).toBe(true);
  });
  it("progresses cut through built and bound once, preserving immutable train intent", () => {
    const bound = bindStableTrain(record, `sha256:${"d".repeat(64)}`, [17, 18]);
    expect(bound.isOk()).toBe(true);
    if (bound.isErr()) return;
    expect(bound.value.state).toBe("bound");
    expect(bound.value.artifactIds).toEqual([17, 18]);
    const { recordDigest: _digest, ...boundContent } = bound.value;
    expect(bound.value.recordDigest).toBe(digestContent(boundContent));
    expect(
      bindStableTrain(bound.value, `sha256:${"e".repeat(64)}`, [19]).isErr(),
    ).toBe(true);
    expect(transitionStableTrain(bound.value, "prepared").isErr()).toBe(true);
  });
  it("skips partial-publish reserved versions on a fresh main cut", () => {
    const partial = { ...content, state: "partial" as const };
    const partialRecord = checkedRecord(partial);
    const recovery = partialPublishRecoveryMetadata(partialRecord);
    expect(recovery.isOk()).toBe(true);
    if (recovery.isErr()) return;
    expect(recovery.value.metadataDigest).toMatch(/^sha256:/);
    expect(recovery.value.recovery).toBe("fresh-main-cut");
    const plan = planStableCut({
      mainHeadSha: "b".repeat(40),
      serverCutAt: new Date("2026-07-20T00:00:00.000Z"),
      partition: {
        stableFiles: [".changeset/stable.md"],
        remainOnMainFiles: [],
      },
      changesets: [
        {
          path: ".changeset/stable.md",
          releases: new Map([["@weaveio/weave-cli", "patch"]]),
        },
      ],
      changesetContents: { ".changeset/stable.md": "stable bytes" },
      packageVersions: {
        "@weaveio/weave-cli": "1.2.2",
        "@weaveio/weave-adapter-opencode": "1.0.0",
        "@weaveio/weave-adapter-claude-code": "1.0.0",
        "@weaveio/weave-adapter-pi": "1.0.0",
      },
      reservedVersions: { "@weaveio/weave-cli": ["1.2.3"] },
    });
    expect(plan.isOk()).toBe(true);
    if (plan.isOk())
      expect(plan.value.record.versions["@weaveio/weave-cli"]).toBe("1.2.4");
  });
});
