import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { PackagePolicyValidator } from "../package-policy.js";
import type { TarEntry, TarInspector } from "../tar-inspector.js";

describe("PackagePolicyValidator", () => {
  it("rejects modified or non-archive bytes before extraction", () => {
    const result = new PackagePolicyValidator().validate(
      new TextEncoder().encode("modified"),
    );
    expect(result.isErr()).toBe(true);
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
