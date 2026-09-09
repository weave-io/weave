import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  ConfigPlanTaskReader,
  type PlanTaskFileReader,
  type PlanTaskPathInfo,
} from "../plan-task-reader.js";

class MemoryPlanReader implements PlanTaskFileReader {
  readonly reads: string[] = [];
  symlink?: string;
  constructor(readonly content = "- [ ] 1. Build") {}
  readBytes(path: string) {
    this.reads.push(path);
    return okAsync(new TextEncoder().encode(this.content));
  }
  realpath(path: string) {
    return okAsync(path);
  }
  lstat(path: string) {
    if (path === this.symlink)
      return okAsync<PlanTaskPathInfo, never>({
        isFile: false,
        isSymlink: true,
      });
    return okAsync<PlanTaskPathInfo, never>({
      isFile: path.endsWith(".md"),
      isSymlink: false,
    });
  }
}

describe("ConfigPlanTaskReader", () => {
  it("reads once and returns a stable hash", async () => {
    const files = new MemoryPlanReader();
    const reader = new ConfigPlanTaskReader("/project", files);
    const first = (await reader.readSnapshot("release"))._unsafeUnwrap();
    const second = (await reader.readSnapshot("release"))._unsafeUnwrap();
    expect(first.contentRevision).toBe(second.contentRevision);
    expect(files.reads).toHaveLength(2);
  });

  it("rejects traversal before I/O and rejects a symlink component", async () => {
    const files = new MemoryPlanReader();
    const reader = new ConfigPlanTaskReader("/project", files);
    expect(
      (await reader.readSnapshot("../secret"))._unsafeUnwrapErr().type,
    ).toBe("InvalidPlanName");
    expect(files.reads).toEqual([]);
    files.symlink = "/project/.weave/plans";
    expect((await reader.readSnapshot("release"))._unsafeUnwrapErr().type).toBe(
      "PlanPathUnsafe",
    );
  });

  it("maps missing and unreadable file errors", async () => {
    const missing: PlanTaskFileReader = {
      readBytes: (path) => errAsync({ type: "Missing", path }),
      realpath: (path) => okAsync(path),
      lstat: (path) =>
        path.endsWith(".md")
          ? errAsync({ type: "Missing", path })
          : okAsync({ isFile: false, isSymlink: false }),
    };
    expect(
      (
        await new ConfigPlanTaskReader("/project", missing).readSnapshot(
          "release",
        )
      )._unsafeUnwrapErr().type,
    ).toBe("PlanMissing");
  });
});
