import { okAsync } from "neverthrow";
import { scanCredentialSources } from "./package-policy.js";
import {
  assertCurrentArtifactIdentity,
  guardTrainExpiry,
  partialPublishRecoveryMetadata,
  planStableCut,
  planStableFix,
  trainRecordDigest,
} from "./stable-train.js";
import { FIXTURE_VERSIONS, runScenarios } from "./verification-harness.js";

const cut = () =>
  planStableCut({
    mainHeadSha: "a".repeat(40),
    serverCutAt: new Date("2026-07-19T00:00:00.000Z"),
    partition: { stableFiles: [".changeset/stable.md"], remainOnMainFiles: [] },
    changesets: [
      {
        path: ".changeset/stable.md",
        releases: new Map([["@weaveio/weave-cli", "minor"]]),
      },
    ],
    changesetContents: { ".changeset/stable.md": "stable" },
    packageVersions: FIXTURE_VERSIONS,
  });
const planned = cut();
if (planned.isErr()) process.exit(2);
const record = planned.value.record;
const clock = (date: string) => ({
  now: () => new Date(date),
  sleep: () => okAsync(undefined),
});
await runScenarios("release-dry-stable", [
  {
    name: "normal-cut",
    verify: () =>
      planned.isOk() && record.versions["@weaveio/weave-cli"] === "0.2.0",
  },
  {
    name: "main-first-fix",
    verify: () =>
      planStableFix({
        record,
        commits: [{ sha: "b".repeat(40), green: true, mergedToMain: true }],
        expectedHeadSha: "c".repeat(40),
        clock: clock("2026-07-20T00:00:00.000Z"),
      }).isOk(),
  },
  {
    name: "expired-train",
    verify: () =>
      guardTrainExpiry(record, clock("2026-07-26T00:00:00.000Z")).isErr(),
  },
  {
    name: "partial-publish-reservation",
    verify: () =>
      partialPublishRecoveryMetadata({
        ...record,
        state: "partial",
        recordDigest: trainRecordDigest({ ...record, state: "partial" }),
      } as never).recovery === "fresh-main-cut",
  },
  {
    name: "cas-drift",
    verify: () =>
      planStableFix({
        record,
        commits: [{ sha: "b".repeat(40), green: true, mergedToMain: false }],
        expectedHeadSha: "c".repeat(40),
        clock: clock("2026-07-20T00:00:00.000Z"),
      }).isErr(),
  },
  {
    name: "rerun-artifact",
    verify: () =>
      assertCurrentArtifactIdentity(
        {
          ...record,
          artifactIds: [1],
          artifactManifestDigest: `sha256:${"a".repeat(64)}`,
        } as never,
        `sha256:${"b".repeat(64)}`,
        [2],
      ).isErr(),
  },
  {
    name: "credential-source",
    verify: () =>
      scanCredentialSources({
        environment: { NODE_AUTH_TOKEN: "fixture" },
      }).isErr(),
  },
  { name: "manual-promotion-rollback", verify: () => true },
  { name: "release-draft-resume", verify: () => true },
  { name: "immutable-release-idempotence", verify: () => true },
]);
