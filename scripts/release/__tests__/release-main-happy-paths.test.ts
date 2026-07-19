import { expect, test } from "bun:test";
import { metadataReplayDigest } from "../metadata-replay.js";
import { trainRecordDigest } from "../stable-train.js";

const sha = "a".repeat(40);
const versions = {
  "@weaveio/weave-cli": "1.0.0",
  "@weaveio/weave-adapter-opencode": "1.0.0",
  "@weaveio/weave-adapter-claude-code": "1.0.0",
};

async function run(script: string, environment: Record<string, string>) {
  const child = Bun.spawn({
    cmd: ["bun", script],
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  return child.exited;
}

test("stable-plan main accepts the workflow's stable-cut input", async () => {
  const input = {
    operation: "stable-cut",
    input: {
      mainHeadSha: sha,
      serverCutAt: "2026-07-19T00:00:00.000Z",
      partition: {
        stableFiles: [".changeset/release.md"],
        remainOnMainFiles: [],
      },
      changesets: [
        {
          path: ".changeset/release.md",
          releases: [["@weaveio/weave-cli", "patch"]],
        },
      ],
      changesetContents: { ".changeset/release.md": "---\n---\n" },
      packageVersions: versions,
    },
  };
  expect(
    await run("scripts/release/stable-plan-main.ts", {
      RELEASE_STABLE_PLAN_INPUT: JSON.stringify(input),
    }),
  ).toBe(0);
});

test("metadata-replay main accepts a canonical no-op replay record", async () => {
  const trainContent = {
    schemaVersion: 1 as const,
    trainRef: "release/20260719-aaaaaaaaaaaa",
    subjectSha: sha,
    cutAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-26T00:00:00.000Z",
    state: "finalized",
    packages: ["@weaveio/weave-cli"],
    versions: { "@weaveio/weave-cli": "1.0.1" },
  };
  const train = {
    ...trainContent,
    recordDigest: trainRecordDigest(trainContent),
  };
  const recordContent = {
    schemaVersion: 1 as const,
    sourceTrainRef: train.trainRef,
    sourceTrainDigest: train.recordDigest,
    subjectSha: train.subjectSha,
    generatedAt: "2026-07-20T00:00:00.000Z",
    versions: train.versions,
    consumedChangesets: [],
    metadataWrites: [],
  };
  const record = {
    ...recordContent,
    recordDigest: metadataReplayDigest(recordContent),
  };
  expect(
    await run("scripts/release/metadata-replay-main.ts", {
      RELEASE_METADATA_REPLAY_INPUT: JSON.stringify({
        record,
        branch: "release-metadata/20260720-aaaaaaaaaaaa",
      }),
    }),
  ).toBe(0);
});
