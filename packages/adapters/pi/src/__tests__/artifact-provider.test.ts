import { describe, expect, it } from "bun:test";
import { FakePiArtifactProvider } from "../artifact-provider.js";

describe("FakePiArtifactProvider", () => {
  it("computes a stable sha256 digest for known file bytes", async () => {
    const provider = new FakePiArtifactProvider(
      new Map([["report.md", new TextEncoder().encode("hello world")]]),
    );
    const result = await provider.readAndDigest({
      projectRoot: "/tmp/project",
      relativePath: "report.md",
    });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.algorithm).toBe("sha256");
    expect(result.value.digest).toHaveLength(64);
    expect(result.value.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an absolute path", async () => {
    const provider = new FakePiArtifactProvider(new Map());
    const result = await provider.readAndDigest({
      projectRoot: "/tmp/project",
      relativePath: "/etc/passwd",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("ArtifactReadFailed");
  });

  it("rejects a path that escapes the project root via ..", async () => {
    const provider = new FakePiArtifactProvider(new Map());
    const result = await provider.readAndDigest({
      projectRoot: "/tmp/project",
      relativePath: "../outside.md",
    });
    expect(result.isErr()).toBe(true);
  });

  it("fails closed for an unknown file", async () => {
    const provider = new FakePiArtifactProvider(new Map());
    const result = await provider.readAndDigest({
      projectRoot: "/tmp/project",
      relativePath: "missing.md",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("ArtifactReadFailed");
  });

  it("produces different digests for different content, same digest for same content", async () => {
    const provider = new FakePiArtifactProvider(
      new Map([
        ["a.md", new TextEncoder().encode("content-a")],
        ["b.md", new TextEncoder().encode("content-b")],
      ]),
    );
    const a1 = await provider.readAndDigest({
      projectRoot: "/tmp",
      relativePath: "a.md",
    });
    const a2 = await provider.readAndDigest({
      projectRoot: "/tmp",
      relativePath: "a.md",
    });
    const b = await provider.readAndDigest({
      projectRoot: "/tmp",
      relativePath: "b.md",
    });
    if (!a1.isOk() || !a2.isOk() || !b.isOk()) throw new Error("unexpected");
    expect(a1.value.digest).toBe(a2.value.digest);
    expect(a1.value.digest).not.toBe(b.value.digest);
  });
});
