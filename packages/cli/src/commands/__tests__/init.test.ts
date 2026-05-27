import { describe, expect, it } from "bun:test";
import { parseArgs } from "../../args.js";
import { MemoryDetectionProbes } from "../../detect/probes.js";
import { MemoryFileSystem } from "../../fs/file-system.js";
import { BufferTerminal } from "../../io/terminal.js";
import { StaticPromptAdapter } from "../../prompt/index.js";
import { ThemeManager } from "../../theme/colors.js";
import { runInit } from "../init.js";

const themeManager = new ThemeManager({ isTty: () => false });

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
      theme: themeManager.getTheme(false),
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
      theme: themeManager.getTheme(false),
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

// ---------------------------------------------------------------------------
// Argument parsing — init submode
// ---------------------------------------------------------------------------

describe("parseArgs — init migrate submode", () => {
  it("parses 'weave init migrate' as initSubmode=migrate", () => {
    const result = parseArgs(["bun", "main.ts", "init", "migrate"]);
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.command).toBe("init");
    expect(parsed.flags.initSubmode).toBe("migrate");
  });

  it("parses 'weave init migrate --scope global' correctly", () => {
    const result = parseArgs([
      "bun",
      "main.ts",
      "init",
      "migrate",
      "--scope",
      "global",
    ]);
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.command).toBe("init");
    expect(parsed.flags.initSubmode).toBe("migrate");
    expect(parsed.flags.scope).toBe("global");
  });

  it("parses 'weave init migrate --scope local --yes' correctly", () => {
    const result = parseArgs([
      "bun",
      "main.ts",
      "init",
      "migrate",
      "--scope",
      "local",
      "--yes",
    ]);
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.command).toBe("init");
    expect(parsed.flags.initSubmode).toBe("migrate");
    expect(parsed.flags.scope).toBe("local");
    expect(parsed.flags.yes).toBe(true);
  });

  it("ordinary 'weave init' has no initSubmode", () => {
    const result = parseArgs(["bun", "main.ts", "init", "--scope", "local"]);
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.command).toBe("init");
    expect(parsed.flags.initSubmode).toBeUndefined();
  });

  it("'weave init migrate --help' sets help flag and initSubmode", () => {
    const result = parseArgs(["bun", "main.ts", "init", "migrate", "--help"]);
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    // --help overrides command to "help"
    expect(parsed.command).toBe("help");
    expect(parsed.flags.initSubmode).toBe("migrate");
    expect(parsed.flags.help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Explicit migrate mode
// ---------------------------------------------------------------------------

describe("runInit — explicit migrate mode (weave init migrate)", () => {
  it("fails with exit 1 when no legacy source exists (local scope)", async () => {
    const { terminal, ctx } = initContext({
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("No legacy config found");
    expect(terminal.err.join("\n")).toContain(".opencode/weave-opencode.jsonc");
  });

  it("fails with exit 1 when no legacy source exists (global scope)", async () => {
    const { terminal, ctx } = initContext({
      overrides: { initSubmode: "migrate", scope: "global", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("No legacy config found");
    expect(terminal.err.join("\n")).toContain(
      ".config/opencode/weave-opencode.jsonc",
    );
  });

  it("migrates local scope to canonical .weave/config.weave", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = initContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const snap = fs.snapshot();
    // Canonical destination: <cwd>/.weave/config.weave
    expect(snap["/project/.weave/config.weave"]).toBeDefined();
    expect(snap["/project/.weave/config.weave"]).toContain(
      "Migrated from legacy OpenCode JSONC config",
    );
    // Source preserved
    expect(snap["/project/.opencode/weave-opencode.jsonc"]).toBeDefined();
    expect(terminal.out.join("\n")).toContain("Migration complete");
  });

  it("migrates global scope to canonical ~/.weave/config.weave", async () => {
    const fs = new MemoryFileSystem(
      {
        "/home/user/.config/opencode/weave-opencode.jsonc":
          '{ "log_level": "INFO" }',
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = initContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "global", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const snap = fs.snapshot();
    // Canonical destination: <home>/.weave/config.weave
    expect(snap["/home/user/.weave/config.weave"]).toBeDefined();
    expect(snap["/home/user/.weave/config.weave"]).toContain(
      "Migrated from legacy OpenCode JSONC config",
    );
    // Source preserved
    expect(
      snap["/home/user/.config/opencode/weave-opencode.jsonc"],
    ).toBeDefined();
    expect(terminal.out.join("\n")).toContain("Migration complete");
  });

  it("creates backup when destination already exists", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
        "/project/.weave/config.weave": "# existing config",
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = initContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const snap = fs.snapshot();
    expect(snap["/project/.weave/config.weave.bak"]).toContain(
      "# existing config",
    );
    expect(terminal.out.join("\n")).toContain("Backup:");
  });

  it("does not create backup when destination does not exist", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = initContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const snap = fs.snapshot();
    expect(snap["/project/.weave/config.weave.bak"]).toBeUndefined();
  });

  it("ignores --install-dir and always writes to canonical destination", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const { ctx } = initContext({
      fs,
      overrides: {
        initSubmode: "migrate",
        scope: "local",
        yes: true,
        // --install-dir should be ignored in migrate mode
        installDir: "/some/custom/dir",
      },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const snap = fs.snapshot();
    // Must write to canonical path, NOT the custom installDir
    expect(snap["/project/.weave/config.weave"]).toBeDefined();
    expect(snap["/some/custom/dir/config.weave"]).toBeUndefined();
  });

  it("requires interactive confirmation when --yes is not set", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    // Prompt that confirms (confirm array: [true])
    const prompt = new StaticPromptAdapter({ confirm: [true] });
    const { terminal, ctx } = initContext({
      fs,
      prompt,
      overrides: { initSubmode: "migrate", scope: "local" },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("Migration complete");
  });

  it("cancels when user declines confirmation", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    // Prompt that declines (confirm array: [false])
    const prompt = new StaticPromptAdapter({ confirm: [false] });
    const { terminal, ctx } = initContext({
      fs,
      prompt,
      overrides: { initSubmode: "migrate", scope: "local" },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("cancelled");
    const snap = fs.snapshot();
    expect(snap["/project/.weave/config.weave"]).toBeUndefined();
  });

  it("fails with exit 1 when non-interactive and --yes not set", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const prompt = new StaticPromptAdapter({ interactive: false });
    const { terminal, ctx } = initContext({
      fs,
      prompt,
      overrides: { initSubmode: "migrate", scope: "local" },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain(
      "Interactive mode is unavailable",
    );
  });

  it("generated migrated config contains provenance comment", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const { ctx } = initContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    const snap = fs.snapshot();
    const content = snap["/project/.weave/config.weave"] ?? "";
    expect(content).toContain("# Migrated from legacy OpenCode JSONC config");
    expect(content).toContain("# Source:");
    expect(content).toContain("weave-opencode.jsonc");
  });
});

// ---------------------------------------------------------------------------
// Ordinary init — migration offer after scope resolution
// ---------------------------------------------------------------------------

describe("runInit — ordinary init migration offer", () => {
  it("offers migration when local legacy source exists and user accepts", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    // Prompt sequence:
    //   select: ["local"]          — scope selection
    //   confirm: [true, true]      — accept migration offer, then confirm harness config
    //   multiselect: [[]]          — no harnesses selected
    const prompt = new StaticPromptAdapter({
      select: ["local"],
      confirm: [true, true],
      multiselect: [[]],
    });
    const { terminal, ctx } = initContext({ fs, prompt });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const snap = fs.snapshot();
    // Canonical destination written
    expect(snap["/project/.weave/config.weave"]).toBeDefined();
    expect(snap["/project/.weave/config.weave"]).toContain(
      "Migrated from legacy OpenCode JSONC config",
    );
    expect(terminal.out.join("\n")).toContain("Migration complete");
  });

  it("skips migration offer when local legacy source does not exist", async () => {
    const fs = new MemoryFileSystem({}, "/project", "/home/user");
    // Prompt sequence:
    //   select: ["local"]          — scope selection
    //   text: ["/project/.weave"]  — install dir (no migration offer)
    //   multiselect: [[]]          — no harnesses
    //   confirm: [true]            — confirm init
    const prompt = new StaticPromptAdapter({
      select: ["local"],
      text: ["/project/.weave"],
      confirm: [true],
      multiselect: [[]],
    });
    const { terminal, ctx } = initContext({ fs, prompt });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const snap = fs.snapshot();
    // Normal init path — no provenance comment
    expect(snap["/project/.weave/config.weave"]).toBeDefined();
    expect(snap["/project/.weave/config.weave"]).not.toContain(
      "Migrated from legacy OpenCode JSONC config",
    );
    expect(terminal.out.join("\n")).not.toContain("Migration complete");
  });

  it("offers migration when global legacy source exists and user accepts", async () => {
    const fs = new MemoryFileSystem(
      {
        "/home/user/.config/opencode/weave-opencode.jsonc":
          '{ "log_level": "INFO" }',
      },
      "/project",
      "/home/user",
    );
    // Prompt sequence:
    //   select: ["global"]         — scope selection
    //   confirm: [true, true]      — accept migration offer, then confirm harness config
    //   multiselect: [[]]          — no harnesses
    const prompt = new StaticPromptAdapter({
      select: ["global"],
      confirm: [true, true],
      multiselect: [[]],
    });
    const { terminal, ctx } = initContext({ fs, prompt });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const snap = fs.snapshot();
    expect(snap["/home/user/.weave/config.weave"]).toBeDefined();
    expect(snap["/home/user/.weave/config.weave"]).toContain(
      "Migrated from legacy OpenCode JSONC config",
    );
    expect(terminal.out.join("\n")).toContain("Migration complete");
  });

  it("proceeds with normal init when user declines migration offer", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    // Prompt sequence:
    //   select: ["local"]          — scope selection
    //   confirm: [false]           — decline migration offer
    //   text: ["/project/.weave"]  — install dir (normal init continues)
    //   multiselect: [[]]          — no harnesses
    //   confirm: [false]           — decline init confirmation → "No changes made"
    const prompt = new StaticPromptAdapter({
      select: ["local"],
      confirm: [false, false],
      text: ["/project/.weave"],
      multiselect: [[]],
    });
    const { terminal, ctx } = initContext({ fs, prompt });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    // Should NOT have migration output
    expect(terminal.out.join("\n")).not.toContain("Migration complete");
  });

  it("migration offer appears after scope resolution (before harness selection)", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    // Prompt sequence: scope → migration offer → harness multiselect → confirm
    const prompt = new StaticPromptAdapter({
      select: ["local"],
      confirm: [true, true],
      multiselect: [[]],
    });
    const { terminal, ctx } = initContext({ fs, prompt });
    await runInit(ctx);
    const out = terminal.out.join("\n");
    // Migration output should be present
    expect(out.indexOf("Migration complete")).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Post-migration continuation
// ---------------------------------------------------------------------------

describe("runInit — post-migration continuation into harness flow", () => {
  it("migration write does not affect source file", async () => {
    const legacyContent = '{ "log_level": "DEBUG" }';
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": legacyContent,
      },
      "/project",
      "/home/user",
    );
    const { ctx } = initContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    const snap = fs.snapshot();
    // Source file must be preserved exactly
    expect(snap["/project/.opencode/weave-opencode.jsonc"]).toBe(legacyContent);
  });

  it("explicit migrate mode exits 0 after successful write", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const { ctx } = initContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
  });

  it("ordinary init migration offer continues to harness flow after write", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    // Accept migration, then select no harnesses, then confirm
    const prompt = new StaticPromptAdapter({
      select: ["local"],
      confirm: [true, true],
      multiselect: [[]],
    });
    const { terminal, ctx } = initContext({ fs, prompt });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    // Migration happened and flow continued (no crash, no error)
    expect(terminal.err.join("\n")).toBe("");
  });
});
