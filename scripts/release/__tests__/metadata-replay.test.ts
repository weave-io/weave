import { describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { Clock } from "../clock.js";
import type { FileSystem } from "../filesystem.js";
import {
  MetadataReplay,
  metadataReplayDigest,
  validatePullRequestHead,
} from "../metadata-replay.js";
import { trainRecordDigest } from "../stable-train.js";

class MemoryFiles implements FileSystem {
  readonly files = new Map<string, string>();
  exists(path: string) {
    return okAsync(this.files.has(path));
  }
  readBytes(path: string) {
    return this.readText(path).map((text) => new TextEncoder().encode(text));
  }
  readText(path: string) {
    const value = this.files.get(path);
    return value === undefined
      ? errAsync({ type: "FileSystemError" as const, path, message: "missing" })
      : okAsync(value);
  }
  writeText(path: string, contents: string) {
    this.files.set(path, contents);
    return okAsync(undefined);
  }
  delete(path: string) {
    this.files.delete(path);
    return okAsync(undefined);
  }
}

const clock: Clock = {
  now: () => new Date("2026-07-20T00:00:00.000Z"),
  sleep: () => okAsync(undefined),
};
const branch = "release-metadata/20260720-aaaaaaaaaaaa";

function replay(files: MemoryFiles) {
  const tool = new MetadataReplay(files, clock);
  const trainContent = {
    schemaVersion: 1 as const,
    trainRef: "release/20260719-aaaaaaaaaaaa",
    subjectSha: "a".repeat(40),
    cutAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-26T00:00:00.000Z",
    state: "finalized" as const,
    packages: ["@weaveio/weave-cli"],
    versions: { "@weaveio/weave-cli": "1.2.3" },
    consumedChangesets: [
      { path: ".changeset/stable.md", preimageDigest: hash("stable") },
    ],
    metadataWrites: [
      {
        path: "packages/cli/package.json",
        contents: '{"version":"1.2.3"}\n',
        contentsDigest: hash('{"version":"1.2.3"}\n'),
      },
      {
        path: "CHANGELOG.md",
        contents: "## 1.2.3\n- stable\n",
        contentsDigest: hash("## 1.2.3\n- stable\n"),
      },
    ],
  };
  const train = {
    ...trainContent,
    recordDigest: trainRecordDigest(trainContent),
  } as never;
  const result = tool.generateReplayRecord(train);
  if (result.isErr()) throw new Error(result.error.type);
  return { tool, record: result.value };
}

describe("metadata replay", () => {
  test("cleanly replays only recorded writes and consumes digest-matched changesets", async () => {
    const files = new MemoryFiles();
    files.files.set(".changeset/stable.md", "stable");
    files.files.set(".changeset/claude.md", "claude later");
    const { tool, record } = replay(files);
    const result = await tool.applyReplay(record, branch);
    expect(result.isOk()).toBe(true);
    expect(files.files.get(".changeset/claude.md")).toBe("claude later");
    expect(files.files.has(".changeset/stable.md")).toBe(false);
    expect([...files.files.keys()].sort()).toEqual([
      ".changeset/claude.md",
      "CHANGELOG.md",
      "packages/cli/package.json",
    ]);
  });

  test("preserves later main files and main-first fixes byte-for-byte", async () => {
    const files = new MemoryFiles();
    files.files.set(".changeset/stable.md", "stable");
    files.files.set(".changeset/later-stable.md", "later stable");
    files.files.set(".changeset/claude.md", "claude\r\nbytes");
    files.files.set("src/fix.ts", "main-first fix\n");
    const { tool, record } = replay(files);
    expect((await tool.applyReplay(record, branch)).isOk()).toBe(true);
    expect(files.files.get(".changeset/later-stable.md")).toBe("later stable");
    expect(files.files.get(".changeset/claude.md")).toBe("claude\r\nbytes");
    expect(files.files.get("src/fix.ts")).toBe("main-first fix\n");
  });

  test("detects version/changelog conflicts before applying any mutation", async () => {
    const files = new MemoryFiles();
    files.files.set(".changeset/stable.md", "stable");
    files.files.set("packages/cli/package.json", '{"version":"9.0.0"}\n');
    const before = new Map(files.files);
    const { tool, record } = replay(files);
    const result = await tool.applyReplay(record, branch);
    expect(result.isErr() && result.error.type).toBe("MetadataConflict");
    expect(files.files).toEqual(before);
  });

  test("rejects changed or missing consumed changesets without deleting them", async () => {
    const changed = new MemoryFiles();
    changed.files.set(".changeset/stable.md", "tampered");
    const changedRun = replay(changed);
    const mismatch = await changedRun.tool.applyReplay(
      changedRun.record,
      branch,
    );
    expect(mismatch.isErr() && mismatch.error.type).toBe(
      "ConsumedChangesetDigestMismatch",
    );
    expect(changed.files.get(".changeset/stable.md")).toBe("tampered");
    const missing = new MemoryFiles();
    const missingRun = replay(missing);
    const absent = await missingRun.tool.applyReplay(missingRun.record, branch);
    expect(absent.isErr() && absent.error.type).toBe(
      "MissingConsumedChangeset",
    );
  });

  test("is idempotent and refuses release branch PR targets", async () => {
    const files = new MemoryFiles();
    files.files.set(".changeset/stable.md", "stable");
    const { tool, record } = replay(files);
    expect((await tool.applyReplay(record, branch)).isOk()).toBe(true);
    expect((await tool.verifyIdempotent(record, branch))._unsafeUnwrap()).toBe(
      true,
    );
    expect((await tool.applyReplay(record, branch)).isOk()).toBe(true);
    expect(
      validatePullRequestHead("release/20260719-aaaaaaaaaaaa").isErr(),
    ).toBe(true);
    expect(
      (await tool.applyReplay(record, "release/20260719-aaaaaaaaaaaa")).isErr(),
    ).toBe(true);
  });

  test("binds replay records to canonical content", () => {
    const files = new MemoryFiles();
    const { record } = replay(files);
    const { recordDigest, ...content } = record;
    expect(recordDigest).toBe(metadataReplayDigest(content));
  });
});

function hash(value: string): string {
  return `sha256:${Bun.CryptoHasher.hash("sha256", value, "hex")}`;
}
