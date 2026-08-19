import { describe, expect, it } from "bun:test";
import {
  expectedPublicPackageInventory,
  TarInspector,
} from "../tar-inspector.js";

const PACKAGE = "@weaveio/weave-cli" as const;

describe("TarInspector", () => {
  it("rejects non-gzip input before parsing or extraction", () => {
    const result = new TarInspector().inspect(
      new TextEncoder().encode("not an archive"),
    );
    expect(result.isErr()).toBe(true);
  });

  it("accepts the exact public inventory and records stable digests", () => {
    const archive = fixtureArchive();
    const first = new TarInspector().inspectPublicPackage(archive, PACKAGE);
    const second = new TarInspector().inspectPublicPackage(archive, PACKAGE);
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    if (first.isErr() || second.isErr()) return;
    expect(first.value.files).toEqual(second.value.files);
    expect(first.value.tarballSha256).toBe(second.value.tarballSha256);
    expect(first.value.entryPointDigests.length).toBeGreaterThan(0);
  });

  it.each([
    ["extra file", { extra: "package/extra.txt" }, "UnexpectedFile"],
    ["missing LICENSE", { remove: "package/LICENSE" }, "MissingFile"],
    ["stub README", { readme: "# Weave CLI\n" }, "StubReadme"],
    [
      "heading-only staged changelog",
      { changelog: "# Weave CLI\n" },
      "StubChangelog",
    ],
    [
      "private source leak",
      { extra: "package/src/private.ts" },
      "UnexpectedFile",
    ],
    ["source map", { extra: "package/dist/index.js.map" }, "UnexpectedFile"],
  ] as const)("rejects %s", (_name, change, expectedType) => {
    const archive = fixtureArchive(change);
    const result = new TarInspector().inspectPublicPackage(archive, PACKAGE);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(expectedType);
  });
});

type FixtureChange = {
  readonly extra?: string;
  readonly remove?: string;
  readonly readme?: string;
  readonly changelog?: string;
};

function fixtureArchive(change: FixtureChange = {}): Uint8Array {
  const paths = expectedPublicPackageInventory(PACKAGE).filter(
    (path) => path !== change.remove,
  );
  if (change.extra !== undefined) paths.push(change.extra);
  const entries = paths.map((path) => {
    if (path === "package/package.json")
      return [path, JSON.stringify({ name: PACKAGE, version: "0.1.0" })];
    if (path === "package/README.md")
      return [
        path,
        change.readme ?? "# Weave CLI\n\nA useful public package.\n",
      ];
    if (path === "package/CHANGELOG.md")
      return [
        path,
        change.changelog ?? "# Weave CLI\n\n## 0.1.0\n\n- Initial release.\n",
      ];
    return [
      path,
      path === "package/LICENSE" ? "MIT License\n" : "export {};\n",
    ];
  });
  const blocks = entries.map(([path, text]) => tarEntry(path, text));
  const contents = new Uint8Array(
    blocks.reduce((size, block) => size + block.byteLength, 1024),
  );
  let offset = 0;
  for (const block of blocks) {
    contents.set(block, offset);
    offset += block.byteLength;
  }
  return Bun.gzipSync(contents);
}

function tarEntry(path: string, text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const padded = Math.ceil(bytes.byteLength / 512) * 512;
  const block = new Uint8Array(512 + padded);
  const header = new TextEncoder().encode(path);
  block.set(header.subarray(0, 100), 0);
  const mode = path === "package/dist/main.js" ? "0000755" : "0000644";
  block.set(new TextEncoder().encode(`${mode}\0`), 100);
  block.set(
    new TextEncoder().encode(
      `${bytes.byteLength.toString(8).padStart(11, "0")}\0`,
    ),
    124,
  );
  block[156] = 48;
  block.set(bytes, 512);
  return block;
}
