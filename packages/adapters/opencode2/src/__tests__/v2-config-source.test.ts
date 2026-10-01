/**
 * Scenarios in `tests/adapters/opencode2.scenario.test.ts` cover what a
 * user observes of this adapter.
 *
 * Kept: the exact-byte source cache and its per-attempt limits. A
 * scenario sees only whether the catalog was rebuilt; it cannot see that the
 * config and prompt readers shared one read, and reaching the byte and count
 * budgets would mean writing megabytes of fixture to disk.
 */

import { describe, expect, it } from "bun:test";
import { modelRecommendationsCachePaths } from "@weaveio/weave-config";
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

describe("model recommendations in the catalog (Spec 39)", () => {
  const projectConfig = "/project/.weave/config.weave";
  const applied = modelRecommendationsCachePaths("stable").applied;
  const encode = (text: string) => new TextEncoder().encode(text);

  async function build(files: ReadonlyMap<string, Uint8Array>) {
    const result = await buildOpenCode2Catalog({
      location: "/project",
      projectConfig: true,
      models: [],
      skills: [],
      sourceIo: new MemorySourceIo(files),
    });
    return result._unsafeUnwrap();
  }

  it("neither reads the cache nor reports an issue without an opt-in", async () => {
    const catalog = await build(new Map());
    expect(catalog.sources.map((source) => source.path)).not.toContain(applied);
    expect(
      catalog.issues.some(
        (issue) => issue.code === "model_updates_unavailable",
      ),
    ).toBe(false);
  });

  it("records a missing applied.json as a source and reports the skipped layer", async () => {
    const catalog = await build(
      new Map([
        [projectConfig, encode("settings { model_updates { mode auto } }")],
      ]),
    );
    expect(catalog.sources).toContainEqual({ path: applied, exists: false });
    expect(catalog.issues).toContainEqual({
      code: "model_updates_unavailable",
    });
    expect(catalog.agents.has("loom")).toBe(true);
  });

  it("keeps every agent when applied.json is corrupt, and records its bytes", async () => {
    const catalog = await build(
      new Map([
        [projectConfig, encode("settings { model_updates { mode notify } }")],
        [applied, encode("{ torn")],
      ]),
    );
    expect(catalog.issues).toContainEqual({
      code: "model_updates_unavailable",
    });
    expect(
      catalog.sources.find((source) => source.path === applied)?.exists,
    ).toBe(true);
    expect(catalog.agents.has("loom")).toBe(true);
  });
});
