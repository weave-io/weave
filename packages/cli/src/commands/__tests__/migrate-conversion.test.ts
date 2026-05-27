/**
 * migrate-conversion.test.ts — Task 3 conversion tests for supported top-level
 * field mapping, unsupported-section warnings, and best-effort write behavior.
 *
 * All tests use MemoryFileSystem — no real filesystem or harness processes.
 *
 * Coverage:
 *   3.1 — Best-effort partial success (supported content written even with warnings)
 *   3.2 — disabled_agents / disabled_hooks / disabled_skills → disable declarations
 *   3.3 — log_level → settings { log_level ... }
 *   3.4 — workflows / continuation / analytics / background → warn + skip
 *   3.5 — Warning-bearing migrations exit with code 0
 *   3.6 — Warning-free successful conversion fixtures
 */

import { describe, expect, it } from "bun:test";
import { parseConfig } from "@weave/core";
import { MemoryFileSystem } from "../../fs/file-system.js";
import { BufferTerminal } from "../../io/terminal.js";
import { StaticPromptAdapter } from "../../prompt/index.js";
import { ThemeManager } from "../../theme/colors.js";
import {
  type ConversionResult,
  convertLegacyJsonc,
  type MigrationPlan,
  runInit,
  writeMigratedDsl,
} from "../init.js";

const themeManager = new ThemeManager({ isTty: () => false });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function migrateContext(input: {
  fs?: MemoryFileSystem;
  prompt?: StaticPromptAdapter;
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
    },
  };
}

/** Minimal MigrationPlan fixture for writeMigratedDsl tests. */
function makePlan(
  fs: MemoryFileSystem,
  overrides: Partial<MigrationPlan> = {},
): MigrationPlan {
  return {
    scope: "local",
    sourcePath: `${fs.cwd()}/.opencode/weave-opencode.jsonc`,
    destinationDir: `${fs.cwd()}/.weave`,
    destinationPath: `${fs.cwd()}/.weave/config.weave`,
    skippedWarningCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit tests for convertLegacyJsonc()
// ---------------------------------------------------------------------------

describe("convertLegacyJsonc — supported field mapping", () => {
  // 3.2 — disabled_agents
  it("maps disabled_agents to disable agents declaration", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ disabled_agents: ["warp", "spindle"] }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('disable agents ["warp", "spindle"]');
  });

  it("maps empty disabled_agents to disable agents []", () => {
    const result = convertLegacyJsonc(JSON.stringify({ disabled_agents: [] }));
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("disable agents []");
  });

  // 3.2 — disabled_hooks
  it("maps disabled_hooks to disable hooks declaration", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ disabled_hooks: ["on-session-idle"] }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('disable hooks ["on-session-idle"]');
  });

  it("maps empty disabled_hooks to disable hooks []", () => {
    const result = convertLegacyJsonc(JSON.stringify({ disabled_hooks: [] }));
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("disable hooks []");
  });

  // 3.2 — disabled_skills
  it("maps disabled_skills to disable skills declaration", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ disabled_skills: ["tdd", "code-review"] }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('disable skills ["tdd", "code-review"]');
  });

  it("maps empty disabled_skills to disable skills []", () => {
    const result = convertLegacyJsonc(JSON.stringify({ disabled_skills: [] }));
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("disable skills []");
  });

  // 3.3 — log_level
  it("maps log_level INFO to settings { log_level INFO }", () => {
    const result = convertLegacyJsonc(JSON.stringify({ log_level: "INFO" }));
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("settings {");
    expect(result.dsl).toContain("  log_level INFO");
    expect(result.dsl).toContain("}");
  });

  it("maps log_level DEBUG to settings { log_level DEBUG }", () => {
    const result = convertLegacyJsonc(JSON.stringify({ log_level: "DEBUG" }));
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("  log_level DEBUG");
  });

  it("normalizes lowercase log_level to uppercase", () => {
    const result = convertLegacyJsonc(JSON.stringify({ log_level: "debug" }));
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("  log_level DEBUG");
  });

  it("normalizes mixed-case log_level to uppercase", () => {
    const result = convertLegacyJsonc(JSON.stringify({ log_level: "Warn" }));
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("  log_level WARN");
  });

  // All supported fields together
  it("converts all supported fields in a single source", () => {
    const source = JSON.stringify({
      disabled_agents: ["warp"],
      disabled_hooks: ["on-session-idle"],
      disabled_skills: ["tdd"],
      log_level: "WARN",
    });
    const result = convertLegacyJsonc(source);
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('disable agents ["warp"]');
    expect(result.dsl).toContain('disable hooks ["on-session-idle"]');
    expect(result.dsl).toContain('disable skills ["tdd"]');
    expect(result.dsl).toContain("  log_level WARN");
  });
});

describe("convertLegacyJsonc — JSONC comment stripping", () => {
  it("strips line comments before parsing", () => {
    const source = `// This is a JSONC comment\n{ "log_level": "INFO" }`;
    const result = convertLegacyJsonc(source);
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("log_level INFO");
  });

  it("strips block comments before parsing", () => {
    const source = `/* block comment */ { "log_level": "DEBUG" }`;
    const result = convertLegacyJsonc(source);
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("log_level DEBUG");
  });

  it("strips inline line comments after values", () => {
    const source = `{ "log_level": "INFO" // inline comment\n}`;
    const result = convertLegacyJsonc(source);
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("log_level INFO");
  });
});

// ---------------------------------------------------------------------------
// 3.4 — Unsupported section warnings
// ---------------------------------------------------------------------------

describe("convertLegacyJsonc — unsupported section warnings", () => {
  it("warns and skips legacy workflows section", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ workflows: { "my-flow": {} } }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("workflows");
    expect(result.warnings[0]!.reason).toContain(
      "not supported in migration v1",
    );
  });

  it("warns and skips legacy continuation section", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ continuation: { recovery: { compaction: true } } }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("continuation");
    expect(result.warnings[0]!.reason).toContain(
      "not supported in migration v1",
    );
  });

  it("warns and skips legacy analytics section", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ analytics: { enabled: true } }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("analytics");
    expect(result.warnings[0]!.reason).toContain(
      "not supported in migration v1",
    );
  });

  it("warns and skips legacy background section", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ background: { enabled: true } }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("background");
    expect(result.warnings[0]!.reason).toContain(
      "not supported in migration v1",
    );
  });

  it("warns on all four unsupported sections simultaneously", () => {
    const source = JSON.stringify({
      workflows: {},
      continuation: {},
      analytics: {},
      background: {},
    });
    const result = convertLegacyJsonc(source);
    expect(result.warnings).toHaveLength(4);
    const fields = result.warnings.map((w) => w.field);
    expect(fields).toContain("workflows");
    expect(fields).toContain("continuation");
    expect(fields).toContain("analytics");
    expect(fields).toContain("background");
  });

  it("warns on unknown legacy fields", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ some_unknown_field: "value" }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("some_unknown_field");
    expect(result.warnings[0]!.reason).toContain("unknown legacy field");
  });
});

// ---------------------------------------------------------------------------
// 3.1 — Best-effort partial success
// ---------------------------------------------------------------------------

describe("convertLegacyJsonc — best-effort partial success", () => {
  it("converts supported fields even when unsupported sections are present", () => {
    const source = JSON.stringify({
      log_level: "INFO",
      disabled_agents: ["warp"],
      workflows: { "my-flow": {} },
      continuation: { recovery: { compaction: true } },
    });
    const result = convertLegacyJsonc(source);
    // Supported fields are converted
    expect(result.dsl).toContain("log_level INFO");
    expect(result.dsl).toContain('disable agents ["warp"]');
    // Unsupported fields produce warnings
    expect(result.warnings).toHaveLength(2);
    const fields = result.warnings.map((w) => w.field);
    expect(fields).toContain("workflows");
    expect(fields).toContain("continuation");
  });

  it("returns empty dsl and one warning when source is unparseable", () => {
    const result = convertLegacyJsonc("{ invalid json !!!");
    expect(result.dsl).toBe("");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("<source>");
    expect(result.warnings[0]!.reason).toContain("failed to parse");
  });

  it("warns on invalid log_level value but still converts other fields", () => {
    const source = JSON.stringify({
      log_level: "VERBOSE",
      disabled_agents: ["warp"],
    });
    const result = convertLegacyJsonc(source);
    // disabled_agents is still converted
    expect(result.dsl).toContain('disable agents ["warp"]');
    // log_level produces a warning
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("log_level");
    expect(result.warnings[0]!.reason).toContain("not a valid log level");
  });

  it("warns when disabled_agents is not an array", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ disabled_agents: "warp" }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("disabled_agents");
    expect(result.warnings[0]!.reason).toContain("expected an array");
  });

  it("warns when disabled_hooks is not an array", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ disabled_hooks: "hook-name" }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("disabled_hooks");
  });

  it("warns when disabled_skills is not an array", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ disabled_skills: "tdd" }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("disabled_skills");
  });

  it("warns when log_level is not a string", () => {
    const result = convertLegacyJsonc(JSON.stringify({ log_level: 42 }));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("log_level");
    expect(result.warnings[0]!.reason).toContain("expected a string");
  });
});

// ---------------------------------------------------------------------------
// 3.6 — Warning-free successful conversion fixtures
// ---------------------------------------------------------------------------

describe("warning-free successful conversion", () => {
  it("empty source object produces no warnings and empty dsl", () => {
    const result = convertLegacyJsonc("{}");
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toBe("");
  });

  it("only supported fields produce no warnings", () => {
    const source = JSON.stringify({
      log_level: "INFO",
      disabled_agents: [],
      disabled_hooks: [],
      disabled_skills: [],
    });
    const result = convertLegacyJsonc(source);
    expect(result.warnings).toHaveLength(0);
  });

  it("converted DSL from supported fields passes parseConfig validation", () => {
    const source = JSON.stringify({
      log_level: "INFO",
      disabled_agents: ["warp"],
      disabled_hooks: ["on-session-idle"],
      disabled_skills: ["tdd"],
    });
    const { dsl } = convertLegacyJsonc(source);
    // The converted DSL must be valid Weave DSL
    const parseResult = parseConfig(dsl);
    expect(parseResult.isOk()).toBe(true);
  });

  it("converted DSL with only log_level passes parseConfig validation", () => {
    const { dsl } = convertLegacyJsonc(JSON.stringify({ log_level: "DEBUG" }));
    const parseResult = parseConfig(dsl);
    expect(parseResult.isOk()).toBe(true);
  });

  it("converted DSL with only disable declarations passes parseConfig validation", () => {
    const source = JSON.stringify({
      disabled_agents: ["warp"],
      disabled_hooks: [],
      disabled_skills: ["tdd"],
    });
    const { dsl } = convertLegacyJsonc(source);
    const parseResult = parseConfig(dsl);
    expect(parseResult.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: runInit with conversion — supported fields written to file
// ---------------------------------------------------------------------------

describe("runInit migration — supported fields written to destination", () => {
  it("writes disable agents declaration from disabled_agents", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          disabled_agents: ["warp", "spindle"],
        }),
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const content = fs.snapshot()["/project/.weave/config.weave"] ?? "";
    expect(content).toContain('disable agents ["warp", "spindle"]');
  });

  it("writes disable hooks declaration from disabled_hooks", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          disabled_hooks: ["on-session-idle"],
        }),
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    const content = fs.snapshot()["/project/.weave/config.weave"] ?? "";
    expect(content).toContain('disable hooks ["on-session-idle"]');
  });

  it("writes disable skills declaration from disabled_skills", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          disabled_skills: ["tdd"],
        }),
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    const content = fs.snapshot()["/project/.weave/config.weave"] ?? "";
    expect(content).toContain('disable skills ["tdd"]');
  });

  it("writes settings { log_level } from log_level", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          log_level: "WARN",
        }),
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    const content = fs.snapshot()["/project/.weave/config.weave"] ?? "";
    expect(content).toContain("settings {");
    expect(content).toContain("  log_level WARN");
  });

  it("writes all supported fields from a full supported-fields fixture", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          disabled_agents: ["warp"],
          disabled_hooks: ["on-session-idle"],
          disabled_skills: ["tdd"],
          log_level: "INFO",
        }),
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const content = fs.snapshot()["/project/.weave/config.weave"] ?? "";
    expect(content).toContain('disable agents ["warp"]');
    expect(content).toContain('disable hooks ["on-session-idle"]');
    expect(content).toContain('disable skills ["tdd"]');
    expect(content).toContain("  log_level INFO");
  });

  it("generated file with supported fields passes parseConfig validation", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          disabled_agents: ["warp"],
          log_level: "DEBUG",
        }),
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    const content = fs.snapshot()["/project/.weave/config.weave"] ?? "";
    const parseResult = parseConfig(content);
    expect(parseResult.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3.4 / 3.5 — Unsupported sections: file still written, exit code 0
// ---------------------------------------------------------------------------

describe("runInit migration — unsupported sections warn but file is written", () => {
  it("exits 0 when unsupported sections are present", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          workflows: { "my-flow": {} },
          log_level: "INFO",
        }),
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    const result = await runInit(ctx);
    // Must exit 0 even with warnings
    expect(result._unsafeUnwrap()).toBe(0);
  });

  it("destination file is written even when unsupported sections are present", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          workflows: { "my-flow": {} },
          log_level: "INFO",
        }),
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    // File must be written despite warnings
    expect(fs.snapshot()["/project/.weave/config.weave"]).toBeDefined();
  });

  it("supported fields are present in output even when unsupported sections are skipped", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          log_level: "DEBUG",
          workflows: { "my-flow": {} },
          continuation: { recovery: { compaction: true } },
        }),
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    const content = fs.snapshot()["/project/.weave/config.weave"] ?? "";
    // Supported field is present
    expect(content).toContain("log_level DEBUG");
    // Unsupported fields are not present
    expect(content).not.toContain("workflows");
    expect(content).not.toContain("continuation");
  });

  it("warning summary appears in output for skipped unsupported sections", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          workflows: { "my-flow": {} },
          analytics: { enabled: true },
          log_level: "INFO",
        }),
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    const out = terminal.out.join("\n");
    // Warning summary must appear
    expect(out).toContain("Migration warnings");
    expect(out).toContain("workflows");
    expect(out).toContain("analytics");
  });

  it("warning summary lists explicit reasons for each skipped field", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          continuation: { recovery: { compaction: true } },
          background: { enabled: true },
        }),
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    const out = terminal.out.join("\n");
    expect(out).toContain("continuation");
    expect(out).toContain("background");
    // Each warning should have a reason
    expect(out).toContain("not supported in migration v1");
  });

  it("preflight shows non-zero skipped-field count when unsupported sections are present", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          workflows: { "my-flow": {} },
          log_level: "INFO",
        }),
      },
      "/project",
      "/home/user",
    );
    const prompt = new StaticPromptAdapter({ confirm: [false] }); // decline to avoid write
    const { terminal, ctx } = migrateContext({
      fs,
      prompt,
      overrides: { initSubmode: "migrate", scope: "local" },
    });
    await runInit(ctx);
    const out = terminal.out.join("\n");
    // Preflight should show warning count > 0
    expect(out).toContain("field(s) will be skipped with warnings");
  });

  it("no warning summary in output when all fields are supported", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          log_level: "INFO",
          disabled_agents: [],
        }),
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    const out = terminal.out.join("\n");
    // No warning summary when no fields are skipped
    expect(out).not.toContain("Migration warnings");
  });

  it("exits 0 with all four unsupported sections present", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          workflows: {},
          continuation: {},
          analytics: {},
          background: {},
        }),
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: writeMigratedDsl with converted content
// ---------------------------------------------------------------------------

describe("writeMigratedDsl with converted DSL content", () => {
  it("writes converted DSL to destination", async () => {
    const fs = new MemoryFileSystem({}, "/project", "/home/user");
    const plan = makePlan(fs);
    const { dsl } = convertLegacyJsonc(
      JSON.stringify({ log_level: "INFO", disabled_agents: ["warp"] }),
    );
    // Wrap in provenance comment to match real migration output
    const content = `# Migrated from legacy OpenCode JSONC config\n# Source: test\n# Scope: local\n# Generated by: weave init migrate\n${dsl}\n`;
    const result = await writeMigratedDsl(fs, plan, content, false);
    expect(result.isOk()).toBe(true);
    const written = fs.snapshot()["/project/.weave/config.weave"] ?? "";
    expect(written).toContain("log_level INFO");
    expect(written).toContain('disable agents ["warp"]');
  });

  it("converted DSL with all supported fields passes validation gate", async () => {
    const fs = new MemoryFileSystem({}, "/project", "/home/user");
    const plan = makePlan(fs);
    const { dsl } = convertLegacyJsonc(
      JSON.stringify({
        disabled_agents: ["warp"],
        disabled_hooks: ["on-session-idle"],
        disabled_skills: ["tdd"],
        log_level: "WARN",
      }),
    );
    const content = `# Migrated from legacy OpenCode JSONC config\n# Source: test\n# Scope: local\n# Generated by: weave init migrate\n${dsl}\n`;
    const result = await writeMigratedDsl(fs, plan, content, false);
    expect(result.isOk()).toBe(true);
  });
});
