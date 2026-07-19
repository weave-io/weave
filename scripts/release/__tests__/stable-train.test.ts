import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import { STABLE_TRAIN_STATES, STABLE_TRAIN_TRANSITIONS } from "../constants.js";
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

  it("formalizes the complete state × state transition matrix", () => {
    for (const from of STABLE_TRAIN_STATES)
      for (const to of STABLE_TRAIN_STATES) {
        const stateful = { ...content, state: from };
        const statefulRecord = {
          ...stateful,
          recordDigest: trainRecordDigest(stateful),
        } as never;
        const result = transitionStableTrain(statefulRecord, to);
        const legal = (
          STABLE_TRAIN_TRANSITIONS[from] as readonly string[]
        ).includes(to);
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
  it("rejects stale artifact identities from rebuilds and rerun attempts", () => {
    const bound = {
      ...record,
      artifactIds: [17],
      artifactManifestDigest: `sha256:${"c".repeat(64)}`,
    } as never;
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
        sleep: () => okAsync(undefined),
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
    const bound = bindStableTrain(
      record as never,
      `sha256:${"d".repeat(64)}`,
      [17, 18],
    );
    expect(bound.isOk()).toBe(true);
    if (bound.isErr()) return;
    expect(bound.value.state).toBe("bound");
    expect(bound.value.artifactIds).toEqual([17, 18]);
    const { recordDigest: _digest, ...boundContent } = bound.value;
    expect(bound.value.recordDigest).toBe(trainRecordDigest(boundContent));
    expect(
      bindStableTrain(bound.value, `sha256:${"e".repeat(64)}`, [19]).isErr(),
    ).toBe(true);
    expect(transitionStableTrain(bound.value, "prepared").isErr()).toBe(true);
  });
  it("skips partial-publish reserved versions on a fresh main cut", () => {
    const partial = { ...content, state: "partial" as const };
    const partialRecord = {
      ...partial,
      recordDigest: trainRecordDigest(partial),
    } as never;
    const recovery = partialPublishRecoveryMetadata(partialRecord);
    expect(recovery.metadataDigest).toMatch(/^sha256:/);
    expect(recovery.recovery).toBe("fresh-main-cut");
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
      },
      reservedVersions: { "@weaveio/weave-cli": ["1.2.3"] },
    });
    expect(plan.isOk()).toBe(true);
    if (plan.isOk())
      expect(plan.value.record.versions["@weaveio/weave-cli"]).toBe("1.2.4");
  });
});
