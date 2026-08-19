import { describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import type { NpmRegistryClient } from "../npm-registry-client.js";
import {
  promotionCommands,
  promotionCommandsFromRegistry,
} from "../promotion-commands.js";
import { type StableTrainContent, trainRecordDigest } from "../stable-train.js";

function trainDigest(value: StableTrainContent): string {
  const result = trainRecordDigest(value);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function authorization(packages: readonly string[]) {
  const trainContent = {
    schemaVersion: 1 as const,
    trainRef: "release/20260719-aaaaaaaaaaaa",
    subjectSha: "a".repeat(40),
    cutAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-26T00:00:00.000Z",
    state: "awaiting-promotion" as const,
    packages,
    versions: Object.fromEntries(
      packages.map((name, index) => [name, `1.2.${index + 3}`]),
    ),
    artifactManifestDigest: `sha256:${"a".repeat(64)}`,
    artifactIds: [42],
  };
  return {
    schemaVersion: 1 as const,
    operation: "stable-publish" as const,
    state: "awaiting-promotion" as const,
    subjectSha: "a".repeat(40),
    packages,
    versions: trainContent.versions,
    artifactDigests: Object.fromEntries(
      packages.map((name) => [name, `sha256:${"b".repeat(64)}`]),
    ),
    originRunId: 123,
    awaitingPromotionTrain: {
      ...trainContent,
      recordDigest: trainDigest(trainContent),
    },
  };
}

interface PromotionCase {
  name: string;
  packages: readonly string[];
  prior: Readonly<Record<string, string>>;
  promote: readonly string[];
  rollback: readonly string[];
}

const PROMOTION_CASES: PromotionCase[] = [
  {
    name: "one package",
    packages: ["@weaveio/weave-cli"],
    prior: { "@weaveio/weave-cli": "1.2.2" },
    promote: ["npm dist-tag add @weaveio/weave-cli@1.2.3 latest"],
    rollback: ["npm dist-tag add @weaveio/weave-cli@1.2.2 latest"],
  },
  {
    name: "two packages",
    packages: ["@weaveio/weave-cli", "@weaveio/weave-adapter-opencode"],
    prior: {
      "@weaveio/weave-cli": "1.2.2",
      "@weaveio/weave-adapter-opencode": "1.2.3",
    },
    promote: [
      "npm dist-tag add @weaveio/weave-cli@1.2.3 latest",
      "npm dist-tag add @weaveio/weave-adapter-opencode@1.2.4 latest",
    ],
    rollback: [
      "npm dist-tag add @weaveio/weave-cli@1.2.2 latest",
      "npm dist-tag add @weaveio/weave-adapter-opencode@1.2.3 latest",
    ],
  },
];

describe("promotionCommands", () => {
  test.each(
    PROMOTION_CASES,
  )("creates exact version-pinned commands for $name", ({
    packages,
    prior,
    promote,
    rollback,
  }) => {
    const result = promotionCommands(authorization(packages), prior);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.promoteCommands).toEqual(promote);
      expect(result.value.rollbackCommands).toEqual(rollback);
    }
  });

  test("reads prior latest values before emitting embedded rollback commands", async () => {
    const registry: NpmRegistryClient = {
      publish: () => okAsync(),
      viewVersion: () => okAsync(""),
      listVersions: () => okAsync([]),
      viewDistTags: () => okAsync({}),
      distTagLs: (packageName) =>
        okAsync({ latest: packageName.endsWith("cli") ? "1.2.2" : "1.2.3" }),
      verifyPublished: () => okAsync(),
    };
    const result = await promotionCommandsFromRegistry(
      authorization(["@weaveio/weave-cli", "@weaveio/weave-adapter-opencode"]),
      registry,
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk())
      expect(result.value.rollbackCommands).toEqual([
        "npm dist-tag add @weaveio/weave-cli@1.2.2 latest",
        "npm dist-tag add @weaveio/weave-adapter-opencode@1.2.3 latest",
      ]);
  });
});
