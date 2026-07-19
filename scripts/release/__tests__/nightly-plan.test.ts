import { describe, expect, test } from "bun:test";
import { okAsync, type ResultAsync } from "neverthrow";
import type { ParsedChangeset } from "../changeset-policy.js";
import type { Clock } from "../clock.js";
import type { RegistryError } from "../errors.js";
import { validateReleaseInvocation } from "../input-validation.js";
import { NightlyPlanner } from "../nightly-plan.js";
import type { NpmRegistryClient } from "../npm-registry-client.js";

const sha = "abcdef123456".padEnd(40, "a");
const clock: Clock = {
  now: () => new Date("2026-07-19T12:00:00.000Z"),
  sleep: () => okAsync(undefined),
};
const invocation = validateReleaseInvocation({
  repository: "weave-io/weave",
  workflowPath: ".github/workflows/publish.yml",
  eventName: "schedule",
  ref: "refs/heads/main",
});
if (invocation.isErr()) throw new Error("fixture invocation is invalid");

class Registry implements NpmRegistryClient {
  constructor(
    private readonly versions: Readonly<Record<string, readonly string[]>>,
  ) {}
  publish(): ResultAsync<void, RegistryError> {
    return okAsync(undefined);
  }
  viewVersion(): ResultAsync<string, RegistryError> {
    return okAsync("");
  }
  viewDistTags(): ResultAsync<Record<string, string>, RegistryError> {
    return okAsync({});
  }
  distTagLs(): ResultAsync<Record<string, string>, RegistryError> {
    return okAsync({});
  }
  verifyPublished(): ResultAsync<void, RegistryError> {
    return okAsync(undefined);
  }
  listVersions(name: string): ResultAsync<readonly string[], RegistryError> {
    return okAsync(this.versions[name] ?? []);
  }
}

const changesets: readonly ParsedChangeset[] = [
  {
    path: ".changeset/cli.md",
    releases: new Map([["@weaveio/weave-cli", "minor"]]),
  },
];
const packageVersions = {
  "@weaveio/weave-cli": "0.1.0",
  "@weaveio/weave-adapter-opencode": "0.1.0",
  "@weaveio/weave-adapter-claude-code": "0.1.0",
} as const;

describe("NightlyPlanner", () => {
  test("uses the highest published stable version and canonical nightly suffix", async () => {
    const result = await new NightlyPlanner(
      new Registry({
        "@weaveio/weave-cli": [
          "1.2.3",
          "1.9.0",
          "2.0.0-nightly.20260101.aaaaaaaaaaaa",
        ],
      }),
      clock,
    ).plan({
      invocation: invocation.value,
      changesets,
      subjectSha: sha,
      packageVersions,
    });
    expect(result._unsafeUnwrap()).toEqual({
      skip: undefined,
      subjectSha: sha,
      packages: [
        {
          name: "@weaveio/weave-cli",
          version: "1.10.0-nightly.20260719.abcdef123456",
          tag: "nightly",
        },
      ],
    });
  });

  test("uses package version only when the registry has no stable version", async () => {
    const result = await new NightlyPlanner(new Registry({}), clock).plan({
      invocation: invocation.value,
      changesets,
      subjectSha: sha,
      packageVersions,
    });
    expect(result._unsafeUnwrap().skip).toBeUndefined();
    if (result.isErr() || result.value.skip !== undefined) return;
    expect(result.value.packages[0]?.version).toBe(
      "0.2.0-nightly.20260719.abcdef123456",
    );
  });

  test("is a green no-public-change skip", async () => {
    const result = await new NightlyPlanner(new Registry({}), clock).plan({
      invocation: invocation.value,
      changesets: [],
      subjectSha: sha,
      packageVersions,
    });
    expect(result._unsafeUnwrap()).toEqual({
      skip: "no-public-change",
      subjectSha: sha,
    });
  });

  test("is a green same-sha skip only when every package has the SHA", async () => {
    const result = await new NightlyPlanner(
      new Registry({
        "@weaveio/weave-cli": ["1.2.3-nightly.20260718.abcdef123456"],
      }),
      clock,
    ).plan({
      invocation: invocation.value,
      changesets,
      subjectSha: sha,
      packageVersions,
    });
    expect(result._unsafeUnwrap()).toEqual({
      skip: "same-sha",
      subjectSha: sha,
    });
  });

  test("rejects a stable operation before registry access", async () => {
    const dispatch = validateReleaseInvocation({
      repository: "weave-io/weave",
      workflowPath: ".github/workflows/publish.yml",
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      operation: "stable-cut",
      channel: "stable",
      subjectSha: sha,
      packages: ["@weaveio/weave-cli"],
      versions: { "@weaveio/weave-cli": "1.0.0" },
    });
    if (dispatch.isErr()) throw new Error("fixture invocation is invalid");
    const result = await new NightlyPlanner(new Registry({}), clock).plan({
      invocation: dispatch.value,
      changesets,
      subjectSha: sha,
      packageVersions,
    });
    expect(result._unsafeUnwrapErr().type).toBe("InvalidNightlyInvocation");
  });
});
