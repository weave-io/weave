import { describe, expect, it } from "bun:test";

const LOADER_SOURCE_URL = new URL("../extension.ts", import.meta.url);
const PACKAGE_MANIFEST_URL = new URL("../../package.json", import.meta.url);

function hasBarePiImport(source: string): boolean {
  return /(?:from\s+|import\s*(?:type\s+)?(?:[\s\S]*?\sfrom\s+)?|\()\s*["']@earendil-works\//.test(
    source,
  );
}

function hasStaticImplImport(source: string): boolean {
  return (
    /from\s+["']\.\/extension-impl\.js["']/.test(source) ||
    /(?:^|[;\n])\s*import\s+["']\.\/extension-impl\.js["']/.test(source)
  );
}

describe("Pi extension entry artifact invariants", () => {
  it("keeps the preloader free of Pi imports and static attested imports", async () => {
    const source = await Bun.file(LOADER_SOURCE_URL).text();
    expect(hasBarePiImport(source)).toBe(false);
    expect(hasStaticImplImport(source)).toBe(false);
    expect(source).not.toMatch(
      /from\s+["']\.\/(?:extension-build-identity|host-module-loader)\.js["']/,
    );
    expect(source).toContain("WEAVE_PI_EMBEDDED_BUILD_BINDING");
  });

  it("registers only the loader in package pi.extensions", async () => {
    const manifest = (await Bun.file(PACKAGE_MANIFEST_URL).json()) as {
      pi?: { extensions?: unknown };
    };
    expect(manifest.pi?.extensions).toEqual(["./dist/extension.js"]);
  });
});
