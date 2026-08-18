import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { PRIVATE_WORKSPACE_NAMES, RELEASE_CHANNELS } from "../constants.js";
import {
  isPublishablePackage,
  PackagePolicyValidator,
  publishablePackageNames,
  releaseChannelsFor,
  resolvePublishablePackage,
} from "../package-policy.js";
import type { TarEntry, TarInspector } from "../tar-inspector.js";

const CATALOG = [
  "@weaveio/weave-cli",
  "@weaveio/weave-adapter-opencode",
  "@weaveio/weave-adapter-claude-code",
  "@weaveio/weave-adapter-pi",
] as const;

describe("publishable package closure", () => {
  it("publishes exactly the four catalog packages", () => {
    expect(publishablePackageNames()).toEqual([...CATALOG]);
  });

  it("gives every catalog package all three channels", () => {
    for (const packageName of CATALOG)
      expect(releaseChannelsFor(packageName)).toEqual([
        "stable",
        "next",
        "nightly",
      ]);
    expect(RELEASE_CHANNELS).toEqual(["stable", "next", "nightly"]);
  });

  it("resolves each catalog package to itself", () => {
    for (const packageName of CATALOG) {
      expect(isPublishablePackage(packageName)).toBe(true);
      const resolved = resolvePublishablePackage(packageName);
      expect(resolved.isOk()).toBe(true);
      if (resolved.isErr()) continue;
      expect(resolved.value).toBe(packageName);
    }
  });

  for (const privateWorkspaceName of PRIVATE_WORKSPACE_NAMES) {
    it(`never publishes the private workspace ${privateWorkspaceName}`, () => {
      expect(isPublishablePackage(privateWorkspaceName)).toBe(false);
      const resolved = resolvePublishablePackage(privateWorkspaceName);
      expect(resolved.isErr()).toBe(true);
      if (resolved.isOk()) return;
      expect(resolved.error).toEqual({
        type: "PrivateWorkspace",
        packageName: privateWorkspaceName,
      });
    });
  }

  it("rejects a fifth package outside the catalog", () => {
    expect(isPublishablePackage("@weaveio/weave-adapter-fifth")).toBe(false);
    const resolved = resolvePublishablePackage("@weaveio/weave-adapter-fifth");
    expect(resolved.isErr()).toBe(true);
    if (resolved.isOk()) return;
    expect(resolved.error).toEqual({
      type: "UnknownPackage",
      packageName: "@weaveio/weave-adapter-fifth",
    });
  });
});

describe("PackagePolicyValidator", () => {
  for (const privateWorkspaceName of PRIVATE_WORKSPACE_NAMES) {
    it(`rejects an archive naming the private workspace ${privateWorkspaceName}`, () => {
      const result = new PackagePolicyValidator(
        namedManifestInspector(privateWorkspaceName),
      ).validate(new Uint8Array());

      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error).toEqual({
        type: "UnexpectedPackage",
        packageName: privateWorkspaceName,
        reason: "PrivateWorkspace",
      });
    });
  }

  it("rejects an archive naming a fifth package", () => {
    const result = new PackagePolicyValidator(
      namedManifestInspector("@weaveio/weave-adapter-fifth"),
    ).validate(new Uint8Array());

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({
      type: "UnexpectedPackage",
      packageName: "@weaveio/weave-adapter-fifth",
      reason: "UnknownPackage",
    });
  });

  it("rejects modified or non-archive bytes before extraction", () => {
    const result = new PackagePolicyValidator().validate(
      new TextEncoder().encode("modified"),
    );
    expect(result.isErr()).toBe(true);
  });

  it("returns a typed error for a null package manifest", () => {
    const result = new PackagePolicyValidator(nullManifestInspector()).validate(
      new Uint8Array(),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("InvalidManifest");
  });

  it.each([
    ["rejects an undeclared allowlisted external", {}, true],
    [
      "accepts a declared allowlisted external",
      { neverthrow: "^8.2.0" },
      false,
    ],
  ])("%s", (_name, dependencies, shouldFail) => {
    const result = new PackagePolicyValidator(
      fakeInspector(dependencies),
    ).validate(new Uint8Array());

    expect(result.isErr()).toBe(shouldFail);
    if (result.isErr())
      expect(result.error).toEqual({
        type: "UndeclaredImport",
        packageName: "@weaveio/weave-adapter-opencode",
        path: "package/dist/index.js",
        specifier: "neverthrow",
      });
  });
});

function fakeInspector(dependencies: Record<string, string>): TarInspector {
  const entries: TarEntry[] = [
    entry(
      "package/package.json",
      JSON.stringify({
        name: "@weaveio/weave-adapter-opencode",
        dependencies,
      }),
    ),
    entry("package/dist/index.js", 'import { ok } from "neverthrow";'),
    entry("package/dist/plugin.js", "export {};"),
    entry("package/dist/index.d.ts", "export {};"),
    entry("package/dist/plugin.d.ts", "export {};"),
    entry("package/README.md", "# Test package"),
  ];
  return { inspect: () => ok(entries) } as unknown as TarInspector;
}

function nullManifestInspector(): TarInspector {
  const entries: TarEntry[] = [entry("package/package.json", "null")];
  return { inspect: () => ok(entries) } as unknown as TarInspector;
}

function namedManifestInspector(packageName: string): TarInspector {
  const entries: TarEntry[] = [
    entry("package/package.json", JSON.stringify({ name: packageName })),
  ];
  return { inspect: () => ok(entries) } as unknown as TarInspector;
}

function entry(path: string, contents: string): TarEntry {
  const encoded = new TextEncoder().encode(contents);
  return {
    path,
    contents: encoded,
    size: encoded.byteLength,
    mode: 0o644,
    type: "0",
  };
}
