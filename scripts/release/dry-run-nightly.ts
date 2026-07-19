import { verifyBindingRecord } from "./artifact-binding.js";
import type { ParsedChangeset } from "./changeset-policy.js";
import { validateReleaseInvocation } from "./input-validation.js";
import { NightlyPlanner } from "./nightly-plan.js";
import { FixtureGitHub, nightlyFixture } from "./release-fixtures.js";
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
const fixture = nightlyFixture();

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
      (await plan({}, { changesets, subjectSha: "not-a-sha" })).match(
        () => false,
        (error) => error.type === "InvalidSubjectSha",
      ),
  },
  {
    name: "invalid-input",
    verify: () => validateReleaseInvocation({ eventName: "schedule" }).isErr(),
  },
  {
    name: "artifact-origin-mismatch",
    verify: async () =>
      (
        await verifyBindingRecord(
          { ...fixture.record, headSha: "c".repeat(40) },
          fixture.context,
          new FixtureGitHub(fixture),
        )
      ).match(
        () => false,
        (error) =>
          error.type === "BindingMismatch" && error.field === "recordDigest",
      ),
  },
  {
    name: "retry-attempt",
    verify: async () =>
      (
        await verifyBindingRecord(
          fixture.record,
          fixture.context,
          new FixtureGitHub(fixture, { runAttempt: 2 }),
        )
      ).match(
        () => false,
        (error) =>
          error.type === "BindingMismatch" && error.field === "runAttempt",
      ),
  },
]);
