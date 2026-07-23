/**
 * Engine-scoped rotating runtime log sink (Spec 33 §19.2).
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  createRotatingRuntimeLogSink,
  identitiesMatch,
  MemoryRuntimeLogFileSystem,
  RotatingRuntimeLogSink,
  wouldRotate,
} from "../runtime/log-sink.js";

describe("wouldRotate / identitiesMatch", () => {
  it("rotates only when segment already has bytes and incoming would exceed max", () => {
    expect(wouldRotate(0, 100, 50)).toBe(false);
    expect(wouldRotate(40, 5, 50)).toBe(false);
    expect(wouldRotate(40, 20, 50)).toBe(true);
  });

  it("matches identities by dev/ino only", () => {
    expect(
      identitiesMatch(
        { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
        { dev: 1, ino: 2, size: 99, mtimeMs: 100 },
      ),
    ).toBe(true);
    expect(
      identitiesMatch(
        { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
        { dev: 1, ino: 3, size: 3, mtimeMs: 4 },
      ),
    ).toBe(false);
  });
});

describe("RotatingRuntimeLogSink with memory filesystem", () => {
  it("writes NDJSON under .weave/runtime/logs with restrictive init", async () => {
    const fs = new MemoryRuntimeLogFileSystem();
    const projectRoot = "/proj";
    const sink = new RotatingRuntimeLogSink({
      projectRoot,
      fileName: "pi-adapter.ndjson",
      settings: { max_segment_bytes: 1024, max_segments: 3 },
      fs,
    });

    const init = await sink.initialize();
    expect(init.isOk()).toBe(true);
    expect(sink.activePath).toBe(
      join(projectRoot, ".weave", "runtime", "logs", "pi-adapter.ndjson"),
    );

    sink.write('{"msg":"hello"}\n');
    await sink.flush();

    const text = fs.readText(sink.activePath);
    expect(text).toContain('"msg":"hello"');
    expect(sink.hasFailed()).toBe(false);
  });

  it("rotates at record boundaries and prunes old segments", async () => {
    const fs = new MemoryRuntimeLogFileSystem();
    const sink = new RotatingRuntimeLogSink({
      projectRoot: "/proj",
      fileName: "engine.ndjson",
      settings: { max_segment_bytes: 20, max_segments: 2 },
      fs,
    });
    await sink.initialize();

    sink.write("aaaaaaaaaa\n"); // 11 bytes
    await sink.flush();
    sink.write("bbbbbbbbbb\n"); // would exceed → rotate first
    await sink.flush();
    sink.write("cccccccccc\n");
    await sink.flush();
    sink.write("dddddddddd\n");
    await sink.flush();

    const paths = fs.paths();
    const rotated = paths.filter((p) => p.includes("engine.ndjson."));
    // max_segments=2 ⇒ active + at most 1 rotated
    expect(rotated.length).toBeLessThanOrEqual(1);
    expect(paths.some((p) => p.endsWith("engine.ndjson"))).toBe(true);
  });

  it("does not recurse on write failure", async () => {
    const fs = new MemoryRuntimeLogFileSystem();
    const sink = new RotatingRuntimeLogSink({
      projectRoot: "/proj",
      fileName: "x.ndjson",
      settings: { max_segment_bytes: 1000, max_segments: 3 },
      fs,
    });
    await sink.initialize();

    // Force failure by removing the active segment out from under the held
    // handle. Identity revalidation must fail closed on the next write.
    await fs.unlinkFile(sink.logDirectory, "x.ndjson");
    sink.write("line\n");
    await sink.flush();

    expect(sink.hasFailed()).toBe(true);
    expect(sink.getLastError()?.type).toBeDefined();

    // Subsequent writes are no-ops and must not throw.
    sink.write("again\n");
    await sink.flush();
    expect(sink.hasFailed()).toBe(true);
  });

  it("fails closed and never synthesizes identity when the log directory cannot be acquired (symlink/access denied)", async () => {
    const fs = new MemoryRuntimeLogFileSystem();
    fs.simulateSymlinkDirectory();
    const sink = new RotatingRuntimeLogSink({
      projectRoot: "/proj",
      fileName: "y.ndjson",
      settings: { max_segment_bytes: 1000, max_segments: 3 },
      fs,
    });

    const init = await sink.initialize();
    expect(init.isOk()).toBe(false);
    expect(init.isErr()).toBe(true);
    expect(init._unsafeUnwrapErr().type).toBe("initialization");
    expect(sink.hasFailed()).toBe(true);

    // No fallback identity was synthesized — the sink never becomes usable.
    sink.write("should not write\n");
    await sink.flush();
    expect(fs.readText(sink.activePath)).toBeUndefined();
  });

  it("fails closed when the parent directory identity is swapped after acquisition", async () => {
    const fs = new MemoryRuntimeLogFileSystem();
    const sink = new RotatingRuntimeLogSink({
      projectRoot: "/proj",
      fileName: "z.ndjson",
      settings: { max_segment_bytes: 1000, max_segments: 3 },
      fs,
    });
    await sink.initialize();
    expect(sink.hasFailed()).toBe(false);

    // Simulate an attacker replacing the parent directory (e.g. symlink swap)
    // after the no-follow handle was acquired.
    fs.swapDirectoryIdentity(sink.logDirectory);

    sink.write("line-after-swap\n");
    await sink.flush();

    expect(sink.hasFailed()).toBe(true);
    expect(sink.getLastError()?.type).toBe("identity");
  });

  it("fails closed when the active segment identity is swapped after acquisition", async () => {
    const fs = new MemoryRuntimeLogFileSystem();
    const sink = new RotatingRuntimeLogSink({
      projectRoot: "/proj",
      fileName: "w.ndjson",
      settings: { max_segment_bytes: 1000, max_segments: 3 },
      fs,
    });
    await sink.initialize();
    expect(sink.hasFailed()).toBe(false);

    // Simulate the segment file being replaced (e.g. symlink swap) under the
    // held file handle.
    fs.swapFileIdentity(sink.logDirectory, "w.ndjson");

    sink.write("line-after-swap\n");
    await sink.flush();

    expect(sink.hasFailed()).toBe(true);
    expect(sink.getLastError()?.type).toBe("identity");
  });

  it("createRotatingRuntimeLogSink initializes before return", async () => {
    const fs = new MemoryRuntimeLogFileSystem();
    const created = await createRotatingRuntimeLogSink({
      projectRoot: "/p",
      fileName: "weave.ndjson",
      fs,
      settings: { max_segment_bytes: 65_536, max_segments: 3 },
    });
    expect(created.isOk()).toBe(true);
    const sink = created._unsafeUnwrap();
    sink.write("{}\n");
    await sink.flush();
    expect(fs.readText(sink.activePath)).toContain("{}");
  });

  it("serializes concurrent writes without interleaving records", async () => {
    const fs = new MemoryRuntimeLogFileSystem();
    const sink = new RotatingRuntimeLogSink({
      projectRoot: "/proj",
      fileName: "s.ndjson",
      settings: { max_segment_bytes: 10_000, max_segments: 3 },
      fs,
    });
    await sink.initialize();

    for (let i = 0; i < 20; i += 1) {
      sink.write(`{"i":${i}}\n`);
    }
    await sink.flush();
    const text = fs.readText(sink.activePath) ?? "";
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('{"i":0}');
    expect(lines[19]).toBe('{"i":19}');
  });
});
