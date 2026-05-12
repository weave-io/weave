import { describe, expect, it } from "bun:test";
import { detectHarnesses } from "../index.js";
import { MemoryDetectionProbes } from "../probes.js";

const files = {
  "/home/user/.config/opencode/config.json": { readable: true },
  "/home/user/.claude/settings.json": { readable: true },
  "/home/user/.pi/config.json": { readable: true },
};

describe("harness detection", () => {
  it("detects all harnesses", async () => {
    const probes = new MemoryDetectionProbes({
      files,
      binaries: {
        opencode: "/bin/opencode",
        claude: "/bin/claude",
        pi: "/bin/pi",
      },
      versions: {
        opencode: "opencode 1.0.0",
        claude: "claude 2.0.0",
        pi: "pi 3.0.0",
      },
    });
    const result = await detectHarnesses(probes);
    expect(result._unsafeUnwrap().map((harness) => harness.id)).toEqual([
      "opencode",
      "claude-code",
      "pi",
    ]);
  });

  it("returns none detected", async () => {
    const probes = new MemoryDetectionProbes();
    const result = await detectHarnesses(probes);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("detects partial harness sets", async () => {
    const probes = new MemoryDetectionProbes({
      files: { "/home/user/.config/opencode/config.json": { readable: true } },
    });
    const result = await detectHarnesses(probes);
    expect(result._unsafeUnwrap().map((harness) => harness.id)).toEqual([
      "opencode",
    ]);
  });

  it("marks unreadable config paths", async () => {
    const probes = new MemoryDetectionProbes({
      files: { "/home/user/.pi/config.json": { readable: false } },
    });
    const result = await detectHarnesses(probes);
    const pi = result._unsafeUnwrap()[0];
    expect(pi.id).toBe("pi");
    expect(pi.readable).toBe(false);
  });

  it("detects PATH-binary-only harnesses", async () => {
    const probes = new MemoryDetectionProbes({
      binaries: { opencode: "/bin/opencode" },
    });
    const result = await detectHarnesses(probes);
    const opencode = result._unsafeUnwrap()[0];
    expect(opencode.id).toBe("opencode");
    expect(opencode.binaryPath).toBe("/bin/opencode");
  });

  it("includes optional version data", async () => {
    const probes = new MemoryDetectionProbes({
      binaries: { opencode: "/bin/opencode" },
      versions: { opencode: "opencode 1.2.3" },
    });
    const result = await detectHarnesses(probes);
    expect(result._unsafeUnwrap()[0].version).toBe("opencode 1.2.3");
  });

  it("does not call write probes", async () => {
    const probes = new MemoryDetectionProbes({
      binaries: { opencode: "/bin/opencode" },
    });
    await detectHarnesses(probes);
    expect(probes.writes).toEqual([]);
  });
});
