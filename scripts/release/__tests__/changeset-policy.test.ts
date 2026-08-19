import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  BunChangesetFileSystem,
  bumpForChangeKind,
  type ChangesetFileSystem,
  type ChangesetPolicyError,
  ChangesetPolicyValidator,
  classifyChangedPath,
  collectPublicImpact,
  deriveChangesetIdentity,
  type PublicImpactChangeset,
  requireChangesetCoverage,
  type ValidatedChangeset,
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

  readBytes(path: string): ResultAsync<Uint8Array, ChangesetPolicyError> {
    const contents = this.files[path.replace(".changeset/", "")];
    if (contents === undefined)
      return errAsync({ type: "Filesystem", path, operation: "read" });
    return okAsync(new TextEncoder().encode(contents));
  }
}

function validate(files: Readonly<Record<string, string>>) {
  return new ChangesetPolicyValidator(
    new MockChangesetFileSystem(files),
  ).validateDirectory(".changeset");
}

function releasing(changeset: ValidatedChangeset): PublicImpactChangeset {
  if (changeset.kind !== "public-impact")
    throw new Error(`Expected a public-impact changeset at ${changeset.path}`);
  return changeset;
}

const featureChangeset = `---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
---

Cap delegation with portable limits that every harness can enforce.

- Effective limits resolve deterministically from the merged configuration.
`;

const breakingChangeset = `---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
"@weaveio/weave-adapter-claude-code": minor
"@weaveio/weave-adapter-pi": minor
---

Declare delegation triggers as plain strings.

Breaking: the \`{ domain, trigger }\` object form is rejected with no alias.

Bundled-source: @weaveio/weave-core
Bundled-source: @weaveio/weave-engine
`;

const emptyChangeset = `---
---

Reason: contributor documentation only; no published artifact changes.
`;

describe("ChangesetPolicyValidator", () => {
  it("accepts a consolidated changeset that names every bundled impact", async () => {
    const result = await validate({ "triggers.md": breakingChangeset });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const changeset = releasing(result.value[0] as ValidatedChangeset);
    expect([...changeset.releases]).toEqual([
      ["@weaveio/weave-cli", "minor"],
      ["@weaveio/weave-adapter-opencode", "minor"],
      ["@weaveio/weave-adapter-claude-code", "minor"],
      ["@weaveio/weave-adapter-pi", "minor"],
    ]);
    expect(changeset.breaking).toBe(
      "the `{ domain, trigger }` object form is rejected with no alias.",
    );
    expect(changeset.bundledSources).toEqual([
      "@weaveio/weave-core",
      "@weaveio/weave-engine",
    ]);
    expect(changeset.summary).toBe(
      "Declare delegation triggers as plain strings.",
    );
  });

  it("accepts a reasoned empty changeset", async () => {
    const result = await validate({ "docs-only.md": emptyChangeset });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value[0]).toMatchObject({
      kind: "empty",
      path: ".changeset/docs-only.md",
      reason: "contributor documentation only; no published artifact changes.",
    });
  });

  it("maps pre-1.0 change kinds onto their bumps", () => {
    expect(bumpForChangeKind("breaking")).toBe("minor");
    expect(bumpForChangeKind("feature")).toBe("minor");
    expect(bumpForChangeKind("fix")).toBe("patch");
  });

  it.each([
    [
      "an empty changeset with no reason",
      {
        "empty.md": `---
---

No reason line here.
`,
      },
      "MissingEmptyReason",
    ],
    [
      "a major bump that the pre-1.0 mapping forbids",
      {
        "major.md": `---
"@weaveio/weave-cli": major
---

Rework the plan model.
`,
      },
      "MajorBumpRejected",
    ],
    [
      "breaking prose without the explicit marker",
      {
        "unmarked.md": `---
"@weaveio/weave-cli": minor
---

Rework the plan model.

- This is a breaking change for stale consumers.
`,
      },
      "UnmarkedBreakingChange",
    ],
    [
      "a marked breaking change bumped as a patch",
      {
        "patched.md": `---
"@weaveio/weave-cli": patch
---

Rework the plan model.

Breaking: the old plan field is gone.
`,
      },
      "BreakingBumpMismatch",
    ],
    [
      "a private package as a bump target",
      {
        "private.md": `---
"@weaveio/weave-engine": patch
"@weaveio/weave-cli": patch
---

Harden the runtime store.
`,
      },
      "PrivateTarget",
    ],
    [
      "an unknown bundled source",
      {
        "unknown-source.md": `---
"@weaveio/weave-cli": patch
---

Harden the runtime store.

Bundled-source: @weaveio/weave-runtime
`,
      },
      "UnknownBundledSource",
    ],
    [
      "a body that opens with a bullet instead of a summary",
      {
        "bulleted.md": `---
"@weaveio/weave-cli": patch
---

- Harden the runtime store.
`,
      },
      "MissingSummary",
    ],
    [
      "an unknown package",
      {
        "unknown.md": `---
"@weaveio/not-real": patch
---

Unknown.
`,
      },
      "UnknownPackage",
    ],
    [
      "an unknown bump",
      {
        "bump.md": `---
"@weaveio/weave-cli": explosive
---

Explosive.
`,
      },
      "UnknownBump",
    ],
    [
      "malformed frontmatter",
      { "malformed.md": "@weaveio/weave-cli: patch" },
      "MalformedFrontmatter",
    ],
    [
      "a reason line on a releasing changeset",
      {
        "reasoned.md": `---
"@weaveio/weave-cli": patch
---

Harden the runtime store.

Reason: nothing to release.
`,
      },
      "UnexpectedMarker",
    ],
  ])("rejects %s", async (_name, files, type) => {
    const result = await validate(files);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.map((error): string => error.type)).toContain(type);
  });

  it("names every public artifact a bundled source omits", async () => {
    const result = await validate({
      "engine.md": `---
"@weaveio/weave-cli": patch
---

Harden the runtime store.

Bundled-source: @weaveio/weave-engine
`,
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(
      result.error.filter((error) => error.type === "MissingPublicImpact"),
    ).toEqual([
      {
        type: "MissingPublicImpact",
        path: ".changeset/engine.md",
        source: "@weaveio/weave-engine",
        packageName: "@weaveio/weave-adapter-opencode",
      },
      {
        type: "MissingPublicImpact",
        path: ".changeset/engine.md",
        source: "@weaveio/weave-engine",
        packageName: "@weaveio/weave-adapter-claude-code",
      },
      {
        type: "MissingPublicImpact",
        path: ".changeset/engine.md",
        source: "@weaveio/weave-engine",
        packageName: "@weaveio/weave-adapter-pi",
      },
    ]);
  });

  it("reports every failing file in one run", async () => {
    const result = await validate({
      "good.md": featureChangeset,
      "major.md": `---
"@weaveio/weave-cli": major
---

Rework the plan model.
`,
      "empty.md": `---
---

Nothing to say.
`,
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.map((error) => error.type).sort()).toEqual([
      "MajorBumpRejected",
      "MissingEmptyReason",
    ]);
  });
});

describe("deriveChangesetIdentity", () => {
  const source = new TextEncoder().encode(
    '---\n"@weaveio/weave-cli": patch\n---\n\nFix a path bug.\n',
  );

  it("derives the filename stem and a SHA-256 over the exact file bytes", () => {
    expect(
      deriveChangesetIdentity(".changeset/windows-memory-fs.md", source),
    ).toEqual({
      id: "windows-memory-fs",
      sourceDigest:
        "369787efdf7bd7d430da975b859a41d4bd913210f6823960232d2b89076a55f3",
    });
  });

  it("keeps the id stable across directories and changes the digest per byte", () => {
    const nested = deriveChangesetIdentity(
      "/repo/.changeset/windows-memory-fs.md",
      source,
    );
    const edited = deriveChangesetIdentity(
      ".changeset/windows-memory-fs.md",
      new TextEncoder().encode(
        '---\n"@weaveio/weave-cli": patch\n---\n\nFix a path bug!\n',
      ),
    );
    expect(nested.id).toBe("windows-memory-fs");
    expect(nested.sourceDigest).toBe(
      deriveChangesetIdentity(".changeset/windows-memory-fs.md", source)
        .sourceDigest,
    );
    expect(edited.id).toBe("windows-memory-fs");
    expect(edited.sourceDigest).not.toBe(nested.sourceDigest);
  });

  it("derives the same identity the validator attaches to a file", async () => {
    const result = await validate({
      "windows-memory-fs.md": new TextDecoder().decode(source),
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value[0]?.identity).toEqual({
      id: "windows-memory-fs",
      sourceDigest:
        "369787efdf7bd7d430da975b859a41d4bd913210f6823960232d2b89076a55f3",
    });
  });
});

describe("classifyChangedPath", () => {
  it.each([
    [
      "packages/cli/src/main.ts",
      { kind: "public", packageName: "@weaveio/weave-cli" },
    ],
    [
      "packages/adapters/pi/README.md",
      { kind: "public", packageName: "@weaveio/weave-adapter-pi" },
    ],
    [
      "packages/engine/src/runtime/store.ts",
      { kind: "bundled", source: "@weaveio/weave-engine" },
    ],
    ["packages/engine/src/__tests__/store.test.ts", { kind: "none" }],
    ["packages/cli/src/commands/compose.test.ts", { kind: "none" }],
    ["packages/docs/astro.config.mjs", { kind: "none" }],
    ["docs/contributing/testing.md", { kind: "none" }],
    ["scripts/release/changeset-policy.ts", { kind: "none" }],
  ])("classifies %s", (path, expected) => {
    expect(classifyChangedPath(path)).toEqual(expected as never);
  });

  it("expands a bundled source into every artifact that packs it", () => {
    expect(collectPublicImpact(["packages/config/src/discovery.ts"])).toEqual({
      packages: [
        "@weaveio/weave-cli",
        "@weaveio/weave-adapter-opencode",
        "@weaveio/weave-adapter-pi",
      ],
      bundledSources: ["@weaveio/weave-config"],
    });
  });
});

describe("requireChangesetCoverage", () => {
  async function changesetsFrom(files: Readonly<Record<string, string>>) {
    const result = await validate(files);
    if (result.isErr()) throw new Error("Fixture changesets must validate");
    return result.value;
  }

  it("needs no changeset when nothing public changes", () => {
    const result = requireChangesetCoverage({
      changedPaths: ["docs/contributing/testing.md"],
      changesets: [],
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.packages).toEqual([]);
  });

  it("rejects a public-impact change with no changeset at all", () => {
    const result = requireChangesetCoverage({
      changedPaths: ["packages/cli/src/main.ts"],
      changesets: [],
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual([
      { type: "MissingChangeset", packages: ["@weaveio/weave-cli"] },
    ]);
  });

  it("accepts a reasoned empty changeset for a public-impact change", async () => {
    const result = requireChangesetCoverage({
      changedPaths: ["packages/cli/src/main.ts"],
      changesets: await changesetsFrom({ "docs-only.md": emptyChangeset }),
    });
    expect(result.isOk()).toBe(true);
  });

  it("requires a bundled change to name every artifact that packs it", async () => {
    const result = requireChangesetCoverage({
      changedPaths: ["packages/engine/src/runtime/store.ts"],
      changesets: await changesetsFrom({ "limits.md": featureChangeset }),
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual([
      {
        type: "UncoveredImpact",
        packageName: "@weaveio/weave-adapter-claude-code",
        source: "@weaveio/weave-engine",
      },
      {
        type: "UncoveredImpact",
        packageName: "@weaveio/weave-adapter-pi",
        source: "@weaveio/weave-engine",
      },
    ]);
  });

  it("accepts a bundled change whose changeset names the full impact", async () => {
    const result = requireChangesetCoverage({
      changedPaths: [
        "packages/engine/src/runtime/store.ts",
        "packages/adapters/pi/src/extension.ts",
      ],
      changesets: await changesetsFrom({ "triggers.md": breakingChangeset }),
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.bundledSources).toEqual(["@weaveio/weave-engine"]);
  });
});

describe("the pending changeset corpus", () => {
  const directory = resolve(import.meta.dir, "../../../.changeset");

  it("passes the policy", async () => {
    const result = await new ChangesetPolicyValidator(
      new BunChangesetFileSystem(),
    ).validateDirectory(directory);
    expect(result.isErr() ? result.error : []).toEqual([]);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.length).toBeGreaterThan(0);
  });

  it("holds no nightly-only duplicate", async () => {
    const files = await Array.fromAsync(
      new Bun.Glob("*.md").scan({ cwd: directory }),
    );
    expect(files.filter((file) => file.includes("nightly"))).toEqual([]);
  });
});
