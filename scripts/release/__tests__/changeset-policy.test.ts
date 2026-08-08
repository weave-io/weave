import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  type ChangesetFileSystem,
  type ChangesetPolicyError,
  ChangesetPolicyValidator,
} from "../changeset-policy.js";

class MockChangesetFileSystem implements ChangesetFileSystem {
  constructor(private readonly files: Readonly<Record<string, string>>) {}

  listMarkdown(
    directory: string,
  ): ResultAsync<readonly string[], ChangesetPolicyError> {
    return okAsync(
      Object.keys(this.files).map((file) => `${directory}/${file}`),
    );
  }

  readText(path: string): ResultAsync<string, ChangesetPolicyError> {
    const contents = this.files[path.replace(".changeset/", "")];
    if (contents === undefined)
      return errAsync({ type: "Filesystem", path, operation: "read" });
    return okAsync(contents);
  }
}

function validate(files: Readonly<Record<string, string>>) {
  return new ChangesetPolicyValidator(
    new MockChangesetFileSystem(files),
  ).validateDirectory(".changeset");
}

const claudeOnly = `---
"@weaveio/weave-adapter-claude-code": minor
---

Claude release`;
const stableOnly = `---
"@weaveio/weave-cli": patch
"@weaveio/weave-adapter-opencode": patch
---

Stable release`;
const piOnly = `---
"@weaveio/weave-adapter-pi": minor
---

Pi release`;

describe("ChangesetPolicyValidator", () => {
  it("accepts stable-only and Claude-only changesets and partitions them", async () => {
    const result = await validate({
      "stable.md": stableOnly,
      "claude.md": claudeOnly,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.stableFiles).toEqual([".changeset/stable.md"]);
    expect(result.value.remainOnMainFiles).toEqual([".changeset/claude.md"]);
  });

  it.each([
    [
      "mixed channels",
      {
        "mixed.md": `${stableOnly.replace("---\n\nStable release", '"@weaveio/weave-adapter-claude-code": patch\n---\n\nMixed')}`,
      },
      "MixedChannels",
      ".changeset/mixed.md",
    ],
    [
      "private target and missing impacts",
      {
        "private.md": `---
"@weaveio/weave-core": patch
"@weaveio/weave-cli": patch
---

Private`,
      },
      "PrivateTarget",
      ".changeset/private.md",
    ],
    [
      "a nightly-only Pi target mixed with a stable target",
      {
        "pi-mixed.md": `---
"@weaveio/weave-adapter-pi": minor
"@weaveio/weave-cli": patch
---

Pi mixed`,
      },
      "MixedChannels",
      ".changeset/pi-mixed.md",
    ],
    [
      "a private engine target even when every public impact is present",
      {
        "private-engine.md": `---
"@weaveio/weave-engine": patch
"@weaveio/weave-cli": patch
"@weaveio/weave-adapter-opencode": patch
"@weaveio/weave-adapter-claude-code": patch
"@weaveio/weave-adapter-pi": patch
---

Private engine`,
      },
      "PrivateTarget",
      ".changeset/private-engine.md",
    ],
    [
      "unknown package",
      {
        "unknown.md": `---
"@weaveio/not-real": patch
---

Unknown`,
      },
      "UnknownPackage",
      ".changeset/unknown.md",
    ],
    [
      "unknown bump",
      {
        "bump.md": `---
"@weaveio/weave-cli": explosive
---

Bump`,
      },
      "UnknownBump",
      ".changeset/bump.md",
    ],
    [
      "malformed frontmatter",
      { "malformed.md": "@weaveio/weave-cli: patch" },
      "MalformedFrontmatter",
      ".changeset/malformed.md",
    ],
  ])("rejects %s with its exact path", async (_name, files, type, path) => {
    const result = await validate(files as Record<string, string>);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(
      result.error.some((error) => error.type === type && error.path === path),
    ).toBe(true);
  });

  it("accepts a Pi-only changeset and keeps it off a stable cut", async () => {
    const result = await validate({ "pi.md": piOnly, "stable.md": stableOnly });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.stableFiles).toEqual([".changeset/stable.md"]);
    expect(result.value.remainOnMainFiles).toEqual([".changeset/pi.md"]);
  });

  it("accepts nightly-only Pi and Claude targets in one changeset", async () => {
    const result = await validate({
      "nightly.md": `---
"@weaveio/weave-adapter-claude-code": patch
"@weaveio/weave-adapter-pi": patch
---

Nightly release`,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.stableFiles).toEqual([]);
    expect(result.value.remainOnMainFiles).toEqual([".changeset/nightly.md"]);
  });

  it("requires the Pi adapter among a private core source's public impacts", async () => {
    const result = await validate({
      "core.md": `---
"@weaveio/weave-core": patch
"@weaveio/weave-cli": patch
"@weaveio/weave-adapter-opencode": patch
"@weaveio/weave-adapter-claude-code": patch
---

Core`,
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(
      result.error.filter((error) => error.type === "MissingPublicImpact"),
    ).toEqual([
      {
        type: "MissingPublicImpact",
        path: ".changeset/core.md",
        source: "@weaveio/weave-core",
        packageName: "@weaveio/weave-adapter-pi",
      },
    ]);
  });

  it("reports every required public impact omitted for a private source", async () => {
    const result = await validate({
      "under-covered.md": `---
"@weaveio/weave-engine": patch
"@weaveio/weave-cli": patch
---

Under-covered`,
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    const missing = result.error.filter(
      (error) => error.type === "MissingPublicImpact",
    );
    expect(missing).toEqual([
      {
        type: "MissingPublicImpact",
        path: ".changeset/under-covered.md",
        source: "@weaveio/weave-engine",
        packageName: "@weaveio/weave-adapter-opencode",
      },
      {
        type: "MissingPublicImpact",
        path: ".changeset/under-covered.md",
        source: "@weaveio/weave-engine",
        packageName: "@weaveio/weave-adapter-claude-code",
      },
      {
        type: "MissingPublicImpact",
        path: ".changeset/under-covered.md",
        source: "@weaveio/weave-engine",
        packageName: "@weaveio/weave-adapter-pi",
      },
    ]);
  });
});
