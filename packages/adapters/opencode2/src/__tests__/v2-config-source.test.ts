import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import { buildOpenCode2Catalog } from "../v2/catalog.js";
import {
  CatalogSourceCache,
  type CatalogSourceIo,
  MAX_CATALOG_SOURCE_BYTES,
  probeCatalogSources,
} from "../v2/config-source.js";

class MemorySourceIo implements CatalogSourceIo {
  readonly reads = new Map<string, number>();
  constructor(private readonly files: ReadonlyMap<string, Uint8Array>) {}
  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  readBytes(path: string) {
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
    const bytes = this.files.get(path);
    if (bytes === undefined) return errAsync({ path, message: "missing" });
    return okAsync(bytes);
  }
}

describe("CatalogSourceCache", () => {
  it("shares exact bytes between config and prompt readers and records their hash", async () => {
    const path = "/project/.weave/shared.md";
    const io = new MemorySourceIo(
      new Map([[path, new TextEncoder().encode("same bytes")]]),
    );
    const cache = new CatalogSourceCache("/project", true, io);
    expect((await cache.configReader.read(path))._unsafeUnwrap()).toBe(
      "same bytes",
    );
    expect((await cache.promptReader.read(path))._unsafeUnwrap()).toBe(
      "same bytes",
    );
    expect(io.reads.get(path)).toBe(1);
    expect(cache.manifest()).toEqual([
      {
        path,
        exists: true,
        bytes: 10,
        sha256: new Bun.CryptoHasher("sha256")
          .update("same bytes")
          .digest("hex"),
      },
    ]);
  });

  it("masks the project config and records later creation as a missing source", async () => {
    const path = "/project/.weave/config.weave";
    const io = new MemorySourceIo(
      new Map([[path, new TextEncoder().encode("agent unsafe {}")]]),
    );
    const cache = new CatalogSourceCache("/project", false, io);
    expect(await cache.configReader.exists(path)).toBe(false);
    expect(cache.manifest()).toEqual([{ path, exists: false }]);
    expect(io.reads.size).toBe(0);
  });

  it("rejects a source larger than the per-attempt byte budget", async () => {
    const path = "/project/large";
    const io = new MemorySourceIo(
      new Map([[path, new Uint8Array(MAX_CATALOG_SOURCE_BYTES + 1)]]),
    );
    const cache = new CatalogSourceCache("/project", true, io);
    expect((await cache.promptReader.read(path)).isErr()).toBe(true);
  });

  it("detects changed, created, and unchanged sources from exact bytes", async () => {
    const existing = "/project/existing";
    const missing = "/project/missing";
    const original = new TextEncoder().encode("original");
    const manifest = [
      {
        path: existing,
        exists: true,
        bytes: original.byteLength,
        sha256: new Bun.CryptoHasher("sha256").update(original).digest("hex"),
      },
      { path: missing, exists: false },
    ];
    const unchanged = new MemorySourceIo(new Map([[existing, original]]));
    expect(
      (await probeCatalogSources(manifest, unchanged))._unsafeUnwrap(),
    ).toBe(false);
    const changed = new MemorySourceIo(
      new Map([[existing, new TextEncoder().encode("changed")]]),
    );
    expect((await probeCatalogSources(manifest, changed))._unsafeUnwrap()).toBe(
      true,
    );
    const created = new MemorySourceIo(
      new Map([
        [existing, original],
        [missing, original],
      ]),
    );
    expect((await probeCatalogSources(manifest, created))._unsafeUnwrap()).toBe(
      true,
    );
  });

  it("rejects a catalog when source existence cannot be checked", async () => {
    const io: CatalogSourceIo = {
      exists: () => Promise.reject(new Error("unreadable")),
      readBytes: (path) => errAsync({ path, message: "unreadable" }),
    };
    const result = await buildOpenCode2Catalog({
      location: "/project",
      projectConfig: true,
      models: [],
      skills: [],
      sourceIo: io,
    });
    expect(result._unsafeUnwrapErr().code).toBe("config_unavailable");
  });
});
