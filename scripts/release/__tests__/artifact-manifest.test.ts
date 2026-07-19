import { describe, expect, it } from "bun:test";
import { validateArtifactManifest } from "../artifact-manifest.js";

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
  ])("rejects %s", (_name, value) =>
    expect(validateArtifactManifest(value).isErr()).toBe(true));
});
