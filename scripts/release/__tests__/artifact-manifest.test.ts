import { describe, expect, it } from "bun:test";
import { validateArtifactManifest } from "../artifact-manifest.js";
import { trainRecordDigest } from "../stable-train.js";

const digest = `sha256:${"a".repeat(64)}`;
const manifest = {
  schemaVersion: 1,
  releaseSubjectSha: "b".repeat(40),
  channel: "stable",
  packages: ["@weaveio/weave-cli"],
  versions: { "@weaveio/weave-cli": "1.2.3" },
  artifacts: [
    {
      filename: "@weaveio-weave-cli-1.2.3.tgz",
      checksumFilename: "@weaveio-weave-cli-1.2.3.tgz.sha256",
      sizeBytes: 12,
      sha256: digest,
    },
  ],
  stableTrain: (() => {
    const content = {
      schemaVersion: 1 as const,
      trainRef: "release/20260719-bbbbbbbbbbbb",
      subjectSha: "b".repeat(40),
      cutAt: "2026-07-19T00:00:00.000Z",
      expiresAt: "2026-07-26T00:00:00.000Z",
      state: "prepared" as const,
      packages: ["@weaveio/weave-cli"],
      versions: { "@weaveio/weave-cli": "1.2.3" },
    };
    return { ...content, recordDigest: trainRecordDigest(content) };
  })(),
};

describe("artifact manifest", () => {
  it.each([["canonical artifact", manifest]])("accepts %s", (_name, value) =>
    expect(validateArtifactManifest(value).isOk()).toBe(true));
  it.each([
    [
      "noncanonical digest",
      {
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0], sha256: "A".repeat(64) }],
      },
    ],
    [
      "path traversal filename",
      {
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0], filename: "../evil.tgz" }],
      },
    ],
    [
      "leading-dash filename",
      {
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0], filename: "-x.tgz" }],
      },
    ],
    [
      "bad checksum name",
      {
        ...manifest,
        artifacts: [
          { ...manifest.artifacts[0], checksumFilename: "other.sha256" },
        ],
      },
    ],
    [
      "wrong package version filename",
      {
        ...manifest,
        artifacts: [
          {
            ...manifest.artifacts[0],
            filename: "@weaveio-weave-cli-9.9.9.tgz",
            checksumFilename: "@weaveio-weave-cli-9.9.9.tgz.sha256",
          },
        ],
      },
    ],
    [
      "oversized artifact",
      {
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0], sizeBytes: 6 * 1024 * 1024 }],
      },
    ],
    [
      "stable Claude",
      {
        ...manifest,
        packages: ["@weaveio/weave-adapter-claude-code"],
        versions: { "@weaveio/weave-adapter-claude-code": "1.2.3" },
      },
    ],
    ["unknown key", { ...manifest, arbitrary: true }],
    [
      "train subject drift",
      {
        ...manifest,
        stableTrain: { ...manifest.stableTrain, subjectSha: "c".repeat(40) },
      },
    ],
    [
      "train package drift",
      {
        ...manifest,
        stableTrain: {
          ...manifest.stableTrain,
          packages: ["@weaveio/weave-adapter-opencode"],
          versions: { "@weaveio/weave-adapter-opencode": "1.2.3" },
        },
      },
    ],
    [
      "train version drift",
      {
        ...manifest,
        stableTrain: {
          ...manifest.stableTrain,
          versions: { "@weaveio/weave-cli": "1.2.4" },
        },
      },
    ],
  ])("rejects %s", (_name, value) =>
    expect(validateArtifactManifest(value).isErr()).toBe(true));
});
