import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import { buildOpenCode2Catalog } from "../v2/catalog.js";
import type { CatalogSourceIo } from "../v2/config-source.js";
import { modelInfo, skillInfo } from "./v2-fixtures.js";

class CatalogIo implements CatalogSourceIo {
  readonly reads = new Map<string, number>();
  constructor(private readonly files: ReadonlyMap<string, string>) {}
  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  readBytes(path: string) {
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
    const source = this.files.get(path);
    if (source === undefined) return errAsync({ path, message: "missing" });
    return okAsync(new TextEncoder().encode(source));
  }
}

describe("buildOpenCode2Catalog", () => {
  it("materializes one location candidate with native model and skill IDs", async () => {
    const path = "/project/.weave/config.weave";
    const io = new CatalogIo(
      new Map([
        [
          path,
          `agent custom {
  prompt "custom role"
  models ["provider/model#high"]
  mode subagent
  skills ["lint"]
}`,
        ],
      ]),
    );
    const result = await buildOpenCode2Catalog({
      location: "/project",
      projectConfig: true,
      models: [modelInfo("provider", "model", ["high"])],
      skills: [skillInfo("skill-lint", "lint")],
      sourceIo: io,
    });
    const candidate = result._unsafeUnwrap();
    expect(candidate.agents.get("custom")?.model).toMatchObject({
      providerID: "provider",
      id: "model",
      variant: "high",
    });
    expect(candidate.runtime.get("custom")?.skillIDs.map(String)).toEqual([
      "skill-lint",
    ]);
    expect(
      candidate.sources.some((source) => source.path === path && source.exists),
    ).toBe(true);
    expect(io.reads.get(path)).toBe(1);
  });

  it("does not publish a candidate from malformed source bytes", async () => {
    const io = new CatalogIo(
      new Map([["/project/.weave/config.weave", "agent broken {"]]),
    );
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
