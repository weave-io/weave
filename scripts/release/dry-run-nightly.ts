import {
  createBindingRecord,
  verifyBindingRecord,
} from "./artifact-binding.js";
import type { ParsedChangeset } from "./changeset-policy.js";
import { validateReleaseInvocation } from "./input-validation.js";
import type { ArtifactManifest } from "./model.js";
import { NightlyPlanner } from "./nightly-plan.js";
import {
  FIXTURE_CLOCK,
  FIXTURE_SHA,
  FIXTURE_VERSIONS,
  FixtureRegistry,
  runScenarios,
} from "./verification-harness.js";

const changesets: readonly ParsedChangeset[] = [
  {
    path: ".changeset/cli.md",
    releases: new Map([["@weaveio/weave-cli", "minor"]]),
  },
];
const invocation = validateReleaseInvocation({
  repository: "weave-io/weave",
  workflowPath: ".github/workflows/publish.yml",
  eventName: "schedule",
  ref: "refs/heads/main",
});
if (invocation.isErr()) process.exit(2);
const plan = (
  versions: Readonly<Record<string, readonly string[]>>,
  input = { changesets, subjectSha: FIXTURE_SHA },
) =>
  new NightlyPlanner(new FixtureRegistry(versions), FIXTURE_CLOCK).plan({
    invocation: invocation.value,
    packageVersions: FIXTURE_VERSIONS,
    ...input,
  });
const digest = (value: string) =>
  `sha256:${Bun.CryptoHasher.hash("sha256", value, "hex")}`;
const manifest: ArtifactManifest = {
  schemaVersion: 1,
  releaseSubjectSha: "a".repeat(40),
  channel: "nightly",
  packages: ["@weaveio/weave-cli"],
  versions: { "@weaveio/weave-cli": "1.0.0-nightly.20260101.aaaaaaaaaaaa" },
  artifacts: [
    {
      filename: "@weaveio-weave-cli-1.0.0-nightly.20260101.aaaaaaaaaaaa.tgz",
      checksumFilename:
        "@weaveio-weave-cli-1.0.0-nightly.20260101.aaaaaaaaaaaa.tgz.sha256",
      sizeBytes: 1,
      sha256: digest("payload"),
    },
  ],
};
const binding = createBindingRecord({
  repositoryId: 1,
  workflowSha: "b".repeat(40),
  runId: 1,
  runAttempt: 1,
  event: "workflow_dispatch",
  operation: "nightly",
  headRef: "refs/heads/main",
  headSha: "a".repeat(40),
  originJobConclusion: "success",
  artifacts: [
    {
      name: "release-payload",
      serverArtifactId: 1,
      uploadDigest: digest("upload"),
      sizeInBytes: 1,
    },
  ],
  manifest,
  manifestDigest: digest(JSON.stringify(manifest)),
  files: [
    {
      filename: manifest.artifacts[0].filename,
      sha256: manifest.artifacts[0].sha256,
    },
  ],
});
const github = {
  getWorkflowRun: () =>
    import("neverthrow").then(({ okAsync }) =>
      okAsync({
        repositoryId: 1,
        id: 1,
        runAttempt: 1,
        event: "workflow_dispatch" as const,
        workflowPath: ".github/workflows/publish.yml",
        workflowSha: "b".repeat(40),
        headRef: "refs/heads/main" as const,
        headSha: "a".repeat(40),
        conclusion: "success" as const,
      }),
    ),
  listRunArtifacts: () =>
    import("neverthrow").then(({ okAsync }) => okAsync([])),
  getArtifact: () => import("neverthrow").then(({ okAsync }) => okAsync({})),
  downloadArtifact: () =>
    import("neverthrow").then(({ okAsync }) => okAsync(new Uint8Array())),
};
const bindingContext = {
  expectedWorkflowSha: "b".repeat(40),
  expectedOperation: "nightly" as const,
  expectedHeadRef: "refs/heads/main" as const,
  expectedHeadSha: "a".repeat(40),
  expectedManifest: manifest,
  expectedManifestDigest: digest(JSON.stringify(manifest)),
  expectedFiles: [
    {
      filename: manifest.artifacts[0].filename,
      sha256: manifest.artifacts[0].sha256,
    },
  ],
};

await runScenarios("release-dry-nightly", [
  {
    name: "disabled",
    verify: () => Bun.env.RELEASE_PUBLISH_ENABLED !== "true",
  },
  {
    name: "changed-packages",
    verify: async () => {
      const result = await plan({ "@weaveio/weave-cli": ["1.9.0"] });
      return (
        result.isOk() &&
        result.value.skip === undefined &&
        result.value.packages[0]?.version ===
          "1.10.0-nightly.20260719.abcdef123456"
      );
    },
  },
  {
    name: "no-change",
    verify: async () => {
      const result = await plan(
        {},
        { changesets: [], subjectSha: FIXTURE_SHA },
      );
      return result.isOk() && result.value.skip === "no-public-change";
    },
  },
  {
    name: "same-sha",
    verify: async () => {
      const result = await plan({
        "@weaveio/weave-cli": ["1.2.3-nightly.20260718.abcdef123456"],
      });
      return result.isOk() && result.value.skip === "same-sha";
    },
  },
  {
    name: "stale-non-green-main",
    verify: async () =>
      (await plan({}, { changesets, subjectSha: "not-a-sha" })).isErr(),
  },
  {
    name: "invalid-input",
    verify: () => validateReleaseInvocation({ eventName: "schedule" }).isErr(),
  },
  {
    name: "artifact-origin-mismatch",
    verify: async () =>
      binding.isErr() ||
      (
        await verifyBindingRecord(
          {
            ...binding.value,
            headSha: "c".repeat(40),
            recordDigest: `sha256:${"0".repeat(64)}`,
          },
          bindingContext,
          github as never,
        )
      ).isErr(),
  },
  {
    name: "retry-attempt",
    verify: async () =>
      binding.isErr() ||
      (
        await verifyBindingRecord(
          {
            ...binding.value,
            runAttempt: 2,
            recordDigest: `sha256:${"0".repeat(64)}`,
          },
          bindingContext,
          github as never,
        )
      ).isErr(),
  },
]);
