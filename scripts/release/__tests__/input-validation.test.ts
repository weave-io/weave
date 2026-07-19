import { describe, expect, it } from "bun:test";
import { validateReleaseInvocation } from "../input-validation.js";
import {
  CanonicalRefSchema,
  DigestSchema,
  NightlyVersionSchema,
  ShortShaSchema,
  StableTagSchema,
} from "../model.js";

const sha = "a".repeat(40);
const base = {
  repository: "weave-io/weave",
  workflowPath: ".github/workflows/publish.yml",
  eventName: "workflow_dispatch",
  ref: "refs/heads/main",
  operation: "nightly",
  channel: "nightly",
  subjectSha: sha,
  packages: ["@weaveio/weave-cli"],
  versions: { "@weaveio/weave-cli": "1.2.3-nightly.20260719.abcdef123456" },
};

describe("validateReleaseInvocation", () => {
  it.each([
    ["nightly dispatch", base],
    [
      "stable dispatch",
      {
        ...base,
        operation: "stable-cut",
        channel: "stable",
        versions: { "@weaveio/weave-cli": "1.2.3" },
      },
    ],
    [
      "scheduled nightly",
      {
        repository: "weave-io/weave",
        workflowPath: ".github/workflows/publish.yml",
        eventName: "schedule",
        ref: "refs/heads/main",
      },
    ],
  ])("accepts %s", (_name, input) =>
    expect(validateReleaseInvocation(input).isOk()).toBe(true));

  it.each([
    ["unknown key", { ...base, injected: "$(whoami)" }],
    ["wrong repository", { ...base, repository: "weave-io/fork" }],
    [
      "wrong workflow",
      { ...base, workflowPath: ".github/workflows/release.yml" },
    ],
    ["noncanonical ref", { ...base, ref: "main" }],
    ["unknown operation", { ...base, operation: "publish" }],
    ["shell sha", { ...base, subjectSha: `${sha.slice(0, 39)};` }],
    ["uppercase sha", { ...base, subjectSha: sha.toUpperCase() }],
    [
      "claude stable",
      {
        ...base,
        operation: "stable-cut",
        channel: "stable",
        packages: ["@weaveio/weave-adapter-claude-code"],
        versions: { "@weaveio/weave-adapter-claude-code": "1.2.3" },
      },
    ],
    [
      "version set confusion",
      { ...base, versions: { "@weaveio/weave-adapter-opencode": "1.2.3" } },
    ],
    [
      "path separator package",
      { ...base, packages: ["@weaveio/weave-cli/evil"] },
    ],
  ])("rejects %s before downstream use", (_name, input) =>
    expect(validateReleaseInvocation(input).isErr()).toBe(true));

  it.each([
    ["release branch", CanonicalRefSchema, "release/20260719-abcdef123456"],
    [
      "metadata branch",
      CanonicalRefSchema,
      "release-metadata/20260719-abcdef123456",
    ],
    ["short SHA", ShortShaSchema, "abcdef123456"],
    ["stable tag", StableTagSchema, "weave-cli-v1.2.3"],
    [
      "nightly version",
      NightlyVersionSchema,
      "1.2.3-nightly.20260719.abcdef123456",
    ],
    ["digest", DigestSchema, `sha256:${"a".repeat(64)}`],
  ])("accepts canonical %s", (_name, schema, value) =>
    expect(schema.safeParse(value).success).toBe(true));

  it.each([
    [
      "branch with slash ambiguity",
      CanonicalRefSchema,
      "release/20260719/abcdef123456",
    ],
    ["uppercase short SHA", ShortShaSchema, "ABCDEF123456"],
    ["arbitrary short SHA", ShortShaSchema, "abcdef1"],
    ["tag prerelease", StableTagSchema, "weave-cli-v1.2.3-rc.1"],
    [
      "nightly uppercase SHA",
      NightlyVersionSchema,
      "1.2.3-nightly.20260719.ABCDEF123456",
    ],
    ["bare digest", DigestSchema, "a".repeat(64)],
  ])("rejects ambiguous %s", (_name, schema, value) =>
    expect(schema.safeParse(value).success).toBe(false));
});
