import { describe, expect, it } from "bun:test";
import { MemoryDetectionProbes } from "../../detect/probes.js";
import { MemoryFileSystem } from "../../fs/file-system.js";
import { BufferTerminal } from "../../io/terminal.js";
import { StaticPromptAdapter } from "../../prompt/index.js";
import { getTheme } from "../../theme/colors.js";
import { runInit } from "../init.js";
import { runValidate } from "../validate.js";

function flags(
  overrides: Partial<Parameters<typeof runInit>[0]["flags"]> = {},
) {
  return {
    help: false,
    version: false,
    json: false,
    yes: false,
    force: false,
    allHarnesses: false,
    project: false,
    global: false,
    ...overrides,
  };
}

function initContext(input: {
  fs?: MemoryFileSystem;
  prompt?: StaticPromptAdapter;
  probes?: MemoryDetectionProbes;
  overrides?: Partial<Parameters<typeof runInit>[0]["flags"]>;
}) {
  const terminal = new BufferTerminal();
  const fs = input.fs ?? new MemoryFileSystem();
  return {
    terminal,
    fs,
    ctx: {
      terminal,
      theme: getTheme(false),
      flags: flags(input.overrides),
      fs,
      prompt: input.prompt,
      probes: input.probes ?? new MemoryDetectionProbes(),
    },
  };
}

describe("init command", () => {
  it("creates global config and prompts non-interactively", async () => {
    const { fs, ctx } = initContext({
      overrides: {
        scope: "global",
        installDir: "/fixture-home/.weave",
        yes: true,
      },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(fs.snapshot()["/fixture-home/.weave/config.weave"]).toContain(
      "agent loom",
    );
  });

  it("creates local config and prompts non-interactively", async () => {
    const { fs, ctx } = initContext({
      overrides: {
        scope: "local",
        installDir: "/fixture-project/.weave",
        yes: true,
      },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(fs.snapshot()["/fixture-project/.weave/config.weave"]).toContain(
      "workflow quick-fix",
    );
  });

  it("is idempotent without force", async () => {
    const fs = new MemoryFileSystem();
    const first = initContext({
      fs,
      overrides: {
        scope: "global",
        installDir: "/fixture-home/.weave",
        yes: true,
      },
    });
    await runInit(first.ctx);
    const second = initContext({
      fs,
      overrides: {
        scope: "global",
        installDir: "/fixture-home/.weave",
        yes: true,
      },
    });
    await runInit(second.ctx);
    expect(second.terminal.out.join("\n")).toContain("Skipped existing config");
  });

  it("creates a backup when force overwrites", async () => {
    const fs = new MemoryFileSystem({
      "/fixture-home/.weave/config.weave": 'agent old { prompt "old" }',
    });
    const { ctx } = initContext({
      fs,
      overrides: {
        scope: "global",
        installDir: "/fixture-home/.weave",
        force: true,
        yes: true,
      },
    });
    await runInit(ctx);
    expect(fs.snapshot()["/fixture-home/.weave/config.weave.bak"]).toContain(
      "agent old",
    );
  });

  it("generated config validates", async () => {
    const fs = new MemoryFileSystem();
    const init = initContext({
      fs,
      overrides: { scope: "local", installDir: "/project/.weave", yes: true },
    });
    await runInit(init.ctx);
    const terminal = new BufferTerminal();
    const result = await runValidate({
      terminal,
      theme: getTheme(false),
      flags: flags({ project: true }),
      fs,
    });
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("Weave config is valid");
  });

  it("reports non-TTY fallback", async () => {
    const { terminal, ctx } = initContext({
      prompt: new StaticPromptAdapter({ interactive: false }),
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain(
      "Interactive mode is unavailable",
    );
  });

  it("handles prompt cancellation with exit code zero", async () => {
    const { terminal, ctx } = initContext({
      prompt: new StaticPromptAdapter({ cancelNext: true }),
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("cancelled");
  });

  it("reports detected harnesses and installs supported explicit OpenCode", async () => {
    const fs = new MemoryFileSystem({
      "/home/user/.config/opencode/config.json": "{}",
    });
    const probes = new MemoryDetectionProbes({
      files: { "/home/user/.config/opencode/config.json": { readable: true } },
    });
    const { terminal, ctx } = initContext({
      fs,
      probes,
      overrides: {
        installDir: "/project/.weave",
        harness: "opencode",
        yes: true,
      },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain(
      "Installed Weave OpenCode integration",
    );
  });
});
