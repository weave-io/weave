import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { errAsync } from "neverthrow";
import { detectHarnesses } from "../index.js";
import {
  BunDetectionProbes,
  MemoryDetectionProbes,
  type ProbeError,
} from "../probes.js";

const files = {
  "/home/user/.config/opencode/config.json": { readable: true },
  "/home/user/.claude/settings.json": { readable: true },
  "/home/user/.pi/config.json": { readable: true },
};

describe("harness detection", () => {
  function withEnv<T>(
    values: { HOME?: string; USERPROFILE?: string },
    callback: () => T,
  ): T {
    const originalHome = Bun.env.HOME;
    const originalUserProfile = Bun.env.USERPROFILE;
    try {
      if (values.HOME === undefined) delete Bun.env.HOME;
      else Bun.env.HOME = values.HOME;
      if (values.USERPROFILE === undefined) delete Bun.env.USERPROFILE;
      else Bun.env.USERPROFILE = values.USERPROFILE;
      return callback();
    } finally {
      if (originalHome === undefined) delete Bun.env.HOME;
      else Bun.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete Bun.env.USERPROFILE;
      else Bun.env.USERPROFILE = originalUserProfile;
    }
  }

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

  it("returns ProbeFailed when required probes fail", async () => {
    class FailingProbes extends MemoryDetectionProbes {
      exists(path: string) {
        return errAsync<boolean, ProbeError>({
          type: "ProbeError",
          operation: "exists",
          path,
          cause: "fixture probe failure",
        });
      }
    }

    const result = await detectHarnesses(new FailingProbes());
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("ProbeFailed");
  });

  it("expands only bare tilde and slash-prefixed tilde paths", () => {
    const probes = new MemoryDetectionProbes({ home: "/home/example" });
    expect(probes.resolvePath("~")).toBe("/home/example");
    expect(probes.resolvePath("~/.config/tool.json")).toBe(
      "/home/example/.config/tool.json",
    );
    expect(
      probes
        .resolvePath("~user/.config/tool.json")
        .endsWith("/~user/.config/tool.json"),
    ).toBe(true);
  });

  it("BunDetectionProbes uses OS home fallback for tilde paths", () => {
    withEnv({ HOME: undefined, USERPROFILE: undefined }, () => {
      const probes = new BunDetectionProbes();

      expect(probes.home()).toBe(homedir());
    });
  });

  it("BunDetectionProbes uses USERPROFILE when HOME is unavailable", () => {
    withEnv({ HOME: undefined, USERPROFILE: "C:\\Users\\weave-test" }, () => {
      const probes = new BunDetectionProbes();

      expect(probes.home()).toBe("C:\\Users\\weave-test");
    });
  });
});
