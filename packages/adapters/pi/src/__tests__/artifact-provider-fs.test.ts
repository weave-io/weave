import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { $ } from "bun";
import { BunPiArtifactProvider } from "../artifact-provider.js";

/**
 * Real Bun filesystem conformance tests (Pi adapter contract) - uses a
 * scratch temp directory only, never the dev project tree. Fixture setup
 * uses Bun's own shell (`Bun.$`) and `Bun.write` rather than `node:fs` -
 * Bun exposes no native `mkdtemp`/`symlink` primitive, and `node:fs` is
 * forbidden runtime surface (AGENTS.md "Runtime — Bun Only"). `Bun.$` here
 * is test-fixture scaffolding only (creating/removing scratch directories
 * and symlinks) - never a security containment decision; the code under
 * test (`BunPiArtifactProvider` → `BunSecureRelativeFileProvider`) proves
 * containment itself via held-descriptor `openat(O_NOFOLLOW)` chains, not
 * by trusting anything this fixture set up.
 */
describe("BunPiArtifactProvider — real filesystem conformance", () => {
  let root: string;

  beforeEach(async () => {
    const result = await $`mktemp -d`.quiet();
    root = result.text().trim();
  });

  afterEach(async () => {
    await $`rm -rf ${root}`.quiet();
  });

  it("reads an ordinary, non-symlinked file and its digest matches a direct hash of the same bytes", async () => {
    const content = "hello from disk";
    await Bun.write(join(root, "report.md"), content);
    const provider = new BunPiArtifactProvider();
    const result = await provider.readAndDigest({
      projectRoot: root,
      relativePath: "report.md",
    });
    expect(result.isOk()).toBe(true);
    const expectedDigest = new Bun.CryptoHasher("sha256")
      .update(new TextEncoder().encode(content))
      .digest("hex");
    if (result.isOk()) {
      expect(result.value.digest).toBe(expectedDigest);
      expect(result.value.byteLength).toBe(content.length);
      expect(result.value.algorithm).toBe("sha256");
    }
  });

  it("reads a nested ordinary file through real ancestor directories", async () => {
    await $`mkdir -p ${join(root, "docs", "plans")}`.quiet();
    await Bun.write(join(root, "docs", "plans", "one.md"), "nested content");
    const provider = new BunPiArtifactProvider();
    const result = await provider.readAndDigest({
      projectRoot: root,
      relativePath: "docs/plans/one.md",
    });
    expect(result.isOk()).toBe(true);
  });

  it("rejects a symlinked file component", async () => {
    await Bun.write(join(root, "real.md"), "real content");
    await $`ln -s ${join(root, "real.md")} ${join(root, "link.md")}`.quiet();
    const provider = new BunPiArtifactProvider();
    const result = await provider.readAndDigest({
      projectRoot: root,
      relativePath: "link.md",
    });
    expect(result.isErr()).toBe(true);
  });

  it("rejects a path via a symlinked directory component", async () => {
    const outsideResult = await $`mktemp -d`.quiet();
    const outside = outsideResult.text().trim();
    await Bun.write(join(outside, "secret.md"), "secret content");
    await $`ln -s ${outside} ${join(root, "linked-dir")}`.quiet();
    const provider = new BunPiArtifactProvider();
    const result = await provider.readAndDigest({
      projectRoot: root,
      relativePath: "linked-dir/secret.md",
    });
    expect(result.isErr()).toBe(true);
    await $`rm -rf ${outside}`.quiet();
  });

  it("rejects an absolute path", async () => {
    await Bun.write(join(root, "report.md"), "hello");
    const provider = new BunPiArtifactProvider();
    const result = await provider.readAndDigest({
      projectRoot: root,
      relativePath: join(root, "report.md"),
    });
    expect(result.isErr()).toBe(true);
  });

  it("rejects a traversal path escaping the project root", async () => {
    const outsideResult = await $`mktemp -d`.quiet();
    const outside = outsideResult.text().trim();
    await Bun.write(join(outside, "secret.md"), "secret content");
    const provider = new BunPiArtifactProvider();
    const result = await provider.readAndDigest({
      projectRoot: root,
      relativePath: `../${outside.split("/").pop()}/secret.md`,
    });
    expect(result.isErr()).toBe(true);
    await $`rm -rf ${outside}`.quiet();
  });

  it("fails closed for a missing file", async () => {
    const provider = new BunPiArtifactProvider();
    const result = await provider.readAndDigest({
      projectRoot: root,
      relativePath: "missing.md",
    });
    expect(result.isErr()).toBe(true);
  });

  it("rejects a non-regular target (a directory presented as the artifact path)", async () => {
    await $`mkdir -p ${join(root, "a-directory")}`.quiet();
    const provider = new BunPiArtifactProvider();
    const result = await provider.readAndDigest({
      projectRoot: root,
      relativePath: "a-directory",
    });
    expect(result.isErr()).toBe(true);
  });

  it("produces a different digest for different content and the same digest across two reads of the same file", async () => {
    await Bun.write(join(root, "a.md"), "content A");
    await Bun.write(join(root, "b.md"), "content B");
    const provider = new BunPiArtifactProvider();
    const [first, second, repeat] = await Promise.all([
      provider.readAndDigest({ projectRoot: root, relativePath: "a.md" }),
      provider.readAndDigest({ projectRoot: root, relativePath: "b.md" }),
      provider.readAndDigest({ projectRoot: root, relativePath: "a.md" }),
    ]);
    expect(first.isOk() && second.isOk() && repeat.isOk()).toBe(true);
    if (first.isOk() && second.isOk() && repeat.isOk()) {
      expect(first.value.digest).not.toBe(second.value.digest);
      expect(first.value.digest).toBe(repeat.value.digest);
    }
  });
});
