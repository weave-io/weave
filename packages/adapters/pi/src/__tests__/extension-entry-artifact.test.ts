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

function hasStaticIdentityImport(source: string): boolean {
  return /from\s+["']\.\/extension-build-identity\.js["']/.test(source);
}

describe("Pi extension entry artifact invariants", () => {
  it("keeps the loader source free of Pi imports and a static impl import", async () => {
    const source = await Bun.file(LOADER_SOURCE_URL).text();
    expect(hasBarePiImport(source)).toBe(false);
    expect(hasStaticImplImport(source)).toBe(false);
    expect(hasStaticIdentityImport(source)).toBe(true);
  });

  it("registers only the loader in package pi.extensions", async () => {
    const manifest = (await Bun.file(PACKAGE_MANIFEST_URL).json()) as {
      pi?: { extensions?: unknown };
    };
    expect(manifest.pi?.extensions).toEqual(["./dist/extension.js"]);
  });
});
