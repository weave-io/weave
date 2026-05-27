/**
 * migrate-conversion.test.ts — Task 3 and Task 4 conversion tests for supported
 * top-level field mapping, unsupported-section warnings, and best-effort write
 * behavior.
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
 *   4.1 — Legacy agents entries as builtin agent overrides
 *   4.2 — Legacy custom_agents entries as new agent blocks
 *   4.3 — Builtin-name collision warnings for custom_agents
 *   4.4 — Ordered model conversion (model + fallback_models → models [...])
 *   4.5 — Category blocks (no flattened shuttle agents)
 *   4.6 — Tool-policy mapping with warnings for ambiguous/unmappable tools
 *   4.7 — Safe prompt_file preservation
 *   4.8 — Unsafe prompt_file references warned and skipped
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
// Task 4 — Agent, category, model, tool, and prompt conversion tests
// ---------------------------------------------------------------------------

// 4.1 — Legacy agents entries as builtin agent overrides
describe("convertLegacyJsonc — agents (builtin overrides)", () => {
  it("converts agents entry for a builtin agent into an agent block", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ agents: { loom: { temperature: 0.2 } } }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("agent loom {");
    expect(result.dsl).toContain("temperature 0.2");
  });

  it("converts agents entry with model override", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { shuttle: { model: "gpt-4o", temperature: 0.3 } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("agent shuttle {");
    expect(result.dsl).toContain('models ["gpt-4o"]');
    expect(result.dsl).toContain("temperature 0.3");
  });

  it("converts agents entry with prompt_append", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { weft: { prompt_append: "Focus on security." } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("agent weft {");
    expect(result.dsl).toContain('prompt_append "Focus on security."');
  });

  it("warns on unsupported agent override field display_name", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { display_name: "My Loom", temperature: 0.1 } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("agents.loom.display_name");
    expect(result.warnings[0]!.reason).toContain("not supported");
    // temperature still converted
    expect(result.dsl).toContain("temperature 0.1");
  });

  it("warns when agents value is not an object", () => {
    const result = convertLegacyJsonc(JSON.stringify({ agents: "invalid" }));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("agents");
    expect(result.warnings[0]!.reason).toContain("expected an object");
  });

  it("converts multiple builtin agent overrides", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: {
          loom: { temperature: 0.1 },
          tapestry: { temperature: 0.2 },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("agent loom {");
    expect(result.dsl).toContain("agent tapestry {");
  });

  // Non-builtin names under `agents` must be warned and skipped — they are not
  // silently promoted to new agents. New agents must come from `custom_agents`.
  it("warns and skips non-builtin name under agents", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ agents: { "my-helper": { temperature: 0.2 } } }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("agents.my-helper");
    expect(result.warnings[0]!.reason).toContain("not a builtin agent name");
    // No agent block generated for non-builtin name
    expect(result.dsl).not.toContain("agent my-helper");
  });

  it("warns and skips multiple non-builtin names under agents", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: {
          "my-helper": { temperature: 0.2 },
          "custom-bot": { model: "gpt-4o" },
        },
      }),
    );
    expect(result.warnings).toHaveLength(2);
    const fields = result.warnings.map((w) => w.field);
    expect(fields).toContain("agents.my-helper");
    expect(fields).toContain("agents.custom-bot");
    expect(result.dsl).not.toContain("agent my-helper");
    expect(result.dsl).not.toContain("agent custom-bot");
  });

  it("converts builtin overrides while warning on non-builtin names under agents", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: {
          loom: { temperature: 0.1 }, // builtin — converted
          "my-helper": { temperature: 0.2 }, // non-builtin — warned and skipped
        },
      }),
    );
    // One warning for the non-builtin name
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("agents.my-helper");
    expect(result.warnings[0]!.reason).toContain("not a builtin agent name");
    // Builtin is converted
    expect(result.dsl).toContain("agent loom {");
    // Non-builtin is not
    expect(result.dsl).not.toContain("agent my-helper");
  });

  it("warning for non-builtin agents entry mentions custom_agents as the correct path", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ agents: { "my-helper": { temperature: 0.2 } } }),
    );
    expect(result.warnings[0]!.reason).toContain("custom_agents");
  });
});

// 4.2 — Legacy custom_agents entries as new agent blocks
describe("convertLegacyJsonc — custom_agents (new agent blocks)", () => {
  it("converts a non-colliding custom agent into an agent block", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          "my-helper": {
            prompt: "You are a helpful assistant.",
            model: "gpt-4o",
          },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("agent my-helper {");
    expect(result.dsl).toContain('prompt "You are a helpful assistant."');
    expect(result.dsl).toContain('models ["gpt-4o"]');
  });

  it("converts custom agent with mode subagent", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          "my-agent": { prompt: "Hello.", mode: "subagent" },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("mode subagent");
  });

  it("converts custom agent with mode primary", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          "my-agent": { prompt: "Hello.", mode: "primary" },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("mode primary");
  });

  it("warns on invalid mode value", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          "my-agent": { prompt: "Hello.", mode: "invalid-mode" },
        },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("custom_agents.my-agent.mode");
    expect(result.warnings[0]!.reason).toContain("not a valid mode");
  });

  it("converts custom agent with prompt_file (safe path)", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          "my-agent": { prompt_file: "my-agent.md" },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('prompt_file "my-agent.md"');
  });

  it("warns on unsupported custom agent field skills", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          "my-agent": { prompt: "Hello.", skills: ["tdd"] },
        },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("custom_agents.my-agent.skills");
    expect(result.warnings[0]!.reason).toContain("not supported");
  });
});

// 4.3 — Builtin-name collision warnings for custom_agents
describe("convertLegacyJsonc — custom_agents builtin collision warnings", () => {
  it("warns and skips custom_agents entry named loom", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: { loom: { prompt: "Override loom." } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("custom_agents.loom");
    expect(result.warnings[0]!.reason).toContain("collides with a builtin");
    // No agent block generated
    expect(result.dsl).not.toContain("agent loom {");
  });

  it("warns and skips custom_agents entry named tapestry", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: { tapestry: { prompt: "Override tapestry." } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("custom_agents.tapestry");
    expect(result.warnings[0]!.reason).toContain("collides with a builtin");
  });

  it("warns on all 8 builtin name collisions", () => {
    const builtins = [
      "loom",
      "tapestry",
      "shuttle",
      "pattern",
      "thread",
      "spindle",
      "weft",
      "warp",
    ];
    const customAgents: Record<string, unknown> = {};
    for (const name of builtins) {
      customAgents[name] = { prompt: `Override ${name}.` };
    }
    const result = convertLegacyJsonc(
      JSON.stringify({ custom_agents: customAgents }),
    );
    expect(result.warnings).toHaveLength(8);
    for (const name of builtins) {
      const w = result.warnings.find(
        (w) => w.field === `custom_agents.${name}`,
      );
      expect(w).toBeDefined();
      expect(w!.reason).toContain("collides with a builtin");
    }
    // No agent blocks generated
    for (const name of builtins) {
      expect(result.dsl).not.toContain(`agent ${name} {`);
    }
  });

  it("converts non-colliding custom agents while warning on colliding ones", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          loom: { prompt: "Override loom." }, // collision
          "my-helper": { prompt: "I help." }, // non-collision
        },
      }),
    );
    // One warning for the collision
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("custom_agents.loom");
    // Non-colliding agent is converted
    expect(result.dsl).toContain("agent my-helper {");
    // Colliding agent is not
    expect(result.dsl).not.toContain("agent loom {");
  });
});

// 4.4 — Ordered model conversion
describe("convertLegacyJsonc — model + fallback_models → ordered models [...]", () => {
  it("converts model alone into models array with single entry", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { model: "claude-sonnet-4-5" } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('models ["claude-sonnet-4-5"]');
  });

  it("converts model + fallback_models into ordered models array", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: {
          loom: {
            model: "claude-sonnet-4-5",
            fallback_models: ["gpt-4o", "gemini-pro"],
          },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain(
      'models ["claude-sonnet-4-5", "gpt-4o", "gemini-pro"]',
    );
  });

  it("primary model appears first in models array", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          "my-agent": {
            prompt: "Hello.",
            model: "primary-model",
            fallback_models: ["fallback-1", "fallback-2"],
          },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    const modelsLine = result.dsl
      .split("\n")
      .find((l) => l.includes("models ["));
    expect(modelsLine).toBeDefined();
    expect(modelsLine).toContain('"primary-model"');
    // primary-model must appear before fallback-1
    const primaryIdx = modelsLine!.indexOf('"primary-model"');
    const fallbackIdx = modelsLine!.indexOf('"fallback-1"');
    expect(primaryIdx).toBeLessThan(fallbackIdx);
  });

  it("warns when model is not a string", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ agents: { loom: { model: 42 } } }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("agents.loom.model");
    expect(result.warnings[0]!.reason).toContain("expected a string");
  });

  it("warns when fallback_models is not an array", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: {
          loom: { model: "claude-sonnet-4-5", fallback_models: "gpt-4o" },
        },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("agents.loom.fallback_models");
    expect(result.warnings[0]!.reason).toContain("expected an array");
    // Primary model still converted
    expect(result.dsl).toContain('models ["claude-sonnet-4-5"]');
  });

  it("converts model in category entries", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: {
            patterns: ["src/api/**"],
            model: "gpt-4o",
            fallback_models: ["claude-sonnet-4-5"],
          },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('models ["gpt-4o", "claude-sonnet-4-5"]');
  });
});

// 4.5 — Category blocks (no flattened shuttle agents)
describe("convertLegacyJsonc — categories → category blocks", () => {
  it("converts a category into a category block", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: {
            description: "Backend APIs",
            patterns: ["src/api/**", "src/server/**"],
          },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("category backend {");
    expect(result.dsl).toContain('description "Backend APIs"');
    expect(result.dsl).toContain('patterns ["src/api/**", "src/server/**"]');
  });

  it("does NOT generate a standalone shuttle-backend agent", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: { patterns: ["src/api/**"] },
        },
      }),
    );
    // Must use category block, not a standalone agent
    expect(result.dsl).toContain("category backend {");
    expect(result.dsl).not.toContain("agent shuttle-backend");
  });

  it("converts multiple categories", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: { patterns: ["src/api/**"] },
          frontend: { patterns: ["src/components/**"] },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("category backend {");
    expect(result.dsl).toContain("category frontend {");
  });

  it("converts category with temperature and prompt_append", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: {
            patterns: ["src/api/**"],
            temperature: 0.2,
            prompt_append: "Focus on API contracts.",
          },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("temperature 0.2");
    expect(result.dsl).toContain('prompt_append "Focus on API contracts."');
  });

  it("warns when patterns is not an array", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: { patterns: "src/api/**" },
        },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("categories.backend.patterns");
    expect(result.warnings[0]!.reason).toContain("expected an array");
  });

  it("warns when categories value is not an object", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ categories: "invalid" }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("categories");
    expect(result.warnings[0]!.reason).toContain("expected an object");
  });

  it("converted category DSL passes parseConfig validation", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: {
            description: "Backend APIs",
            patterns: ["src/api/**"],
            temperature: 0.2,
          },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    const parseResult = parseConfig(result.dsl);
    expect(parseResult.isOk()).toBe(true);
  });
});

// 4.6 — Tool-policy mapping with warnings for ambiguous/unmappable tools
describe("convertLegacyJsonc — tool_policy mapping", () => {
  it("maps known legacy tool 'write' to write capability allow", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { tools: { write: true } } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("tool_policy {");
    expect(result.dsl).toContain("write allow");
  });

  it("maps known legacy tool 'write' to write capability deny when false", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { tools: { write: false } } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("write deny");
  });

  it("maps known legacy tool 'bash' to execute capability", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { tools: { bash: true } } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("execute allow");
  });

  it("maps known legacy tool 'task' to delegate capability", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { tools: { task: true } } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("delegate allow");
  });

  it("maps known legacy tool 'edit' to write capability", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { tools: { edit: true } } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("write allow");
  });

  it("maps known legacy tool 'web_search' to network capability", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { tools: { web_search: true } } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("network allow");
  });

  it("warns on ambiguous legacy tool call_weave_agent", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { tools: { call_weave_agent: true } } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe(
      "agents.loom.tools.call_weave_agent",
    );
    expect(result.warnings[0]!.reason).toContain("harness-specific");
  });

  it("warns on ambiguous legacy tool todowrite", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { tools: { todowrite: true } } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("agents.loom.tools.todowrite");
    expect(result.warnings[0]!.reason).toContain("harness-specific");
  });

  it("warns on unknown legacy tool name", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { tools: { some_unknown_tool: true } } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe(
      "agents.loom.tools.some_unknown_tool",
    );
    expect(result.warnings[0]!.reason).toContain("unknown legacy tool name");
  });

  it("converts known tools while warning on ambiguous ones", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: {
          loom: {
            tools: {
              write: true,
              bash: true,
              call_weave_agent: true, // ambiguous
              todowrite: false, // ambiguous
            },
          },
        },
      }),
    );
    // Two warnings for ambiguous tools
    expect(result.warnings).toHaveLength(2);
    // Known tools are converted
    expect(result.dsl).toContain("write allow");
    expect(result.dsl).toContain("execute allow");
  });

  it("tool_policy block appears in category blocks", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: {
            patterns: ["src/api/**"],
            tools: { write: true, read: true },
          },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("tool_policy {");
    expect(result.dsl).toContain("write allow");
    expect(result.dsl).toContain("read allow");
  });
});

// 4.7 — Safe prompt_file preservation
describe("convertLegacyJsonc — safe prompt_file preservation", () => {
  it("preserves a bare filename prompt_file in agent override", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { prompt_file: "loom-custom.md" } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('prompt_file "loom-custom.md"');
  });

  it("preserves a bare filename prompt_file in custom agent", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          "my-agent": { prompt_file: "my-agent.md" },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('prompt_file "my-agent.md"');
  });

  it("preserves prompt_file with .md extension", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          "my-agent": { prompt_file: "custom-prompt.md" },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('prompt_file "custom-prompt.md"');
  });
});

// 4.8 — Unsafe prompt_file references warned and skipped
describe("convertLegacyJsonc — unsafe prompt_file references warned and skipped", () => {
  it("warns and skips prompt_file with directory separator", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { prompt_file: "subdir/loom.md" } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("agents.loom.prompt_file");
    expect(result.warnings[0]!.reason).toContain("directory components");
    expect(result.dsl).not.toContain("prompt_file");
  });

  it("warns and skips prompt_file with absolute path", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { prompt_file: "/absolute/path/loom.md" } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("agents.loom.prompt_file");
    expect(result.warnings[0]!.reason).toContain("directory components");
    expect(result.dsl).not.toContain("prompt_file");
  });

  it("warns and skips prompt_file with parent directory traversal", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { prompt_file: "../prompts/loom.md" } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("agents.loom.prompt_file");
    expect(result.warnings[0]!.reason).toContain("directory components");
    expect(result.dsl).not.toContain("prompt_file");
  });

  it("warns and skips prompt_file in custom agent with directory path", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          "my-agent": { prompt_file: "prompts/my-agent.md" },
        },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe(
      "custom_agents.my-agent.prompt_file",
    );
    expect(result.warnings[0]!.reason).toContain("directory components");
    expect(result.dsl).not.toContain("prompt_file");
  });

  it("warning does not dump source file content", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { prompt_file: "subdir/loom.md" } },
      }),
    );
    // Warning reason must not contain the full source content
    const warningText = result.warnings.map((w) => w.reason).join(" ");
    expect(warningText).not.toContain('"agents"');
    expect(warningText).not.toContain('"loom"');
  });
});

// ---------------------------------------------------------------------------
// Task 4 — Integration: full agent/category fixture generates valid DSL
// ---------------------------------------------------------------------------

describe("convertLegacyJsonc — full agent/category fixture", () => {
  it("generates DSL with builtin overrides, custom agents, and categories", () => {
    const source = JSON.stringify({
      agents: {
        loom: { temperature: 0.2, model: "claude-sonnet-4-5" },
        shuttle: { temperature: 0.3 },
      },
      custom_agents: {
        "my-helper": {
          prompt: "You are a helpful assistant.",
          model: "gpt-4o",
          mode: "subagent",
        },
      },
      categories: {
        backend: {
          description: "Backend APIs",
          patterns: ["src/api/**"],
          model: "claude-sonnet-4-5",
        },
      },
    });
    const result = convertLegacyJsonc(source);
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("agent loom {");
    expect(result.dsl).toContain("agent shuttle {");
    expect(result.dsl).toContain("agent my-helper {");
    expect(result.dsl).toContain("category backend {");
  });

  it("full fixture DSL passes parseConfig validation", () => {
    const source = JSON.stringify({
      agents: {
        loom: { temperature: 0.2 },
      },
      custom_agents: {
        "my-helper": {
          prompt: "You are a helpful assistant.",
          model: "gpt-4o",
          mode: "subagent",
        },
      },
      categories: {
        backend: {
          description: "Backend APIs",
          patterns: ["src/api/**"],
        },
      },
    });
    const result = convertLegacyJsonc(source);
    expect(result.warnings).toHaveLength(0);
    const parseResult = parseConfig(result.dsl);
    expect(parseResult.isOk()).toBe(true);
  });

  it("builtin collision warning appears alongside successful non-colliding conversions", () => {
    const source = JSON.stringify({
      custom_agents: {
        loom: { prompt: "Override loom." }, // collision
        "my-helper": { prompt: "I help." }, // non-collision
      },
      categories: {
        backend: { patterns: ["src/api/**"] },
      },
    });
    const result = convertLegacyJsonc(source);
    // One warning for the collision
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("custom_agents.loom");
    // Non-colliding agent and category are converted
    expect(result.dsl).toContain("agent my-helper {");
    expect(result.dsl).toContain("category backend {");
  });
});

// ---------------------------------------------------------------------------
// Task 4 — Integration: runInit with agent/category conversion
// ---------------------------------------------------------------------------

describe("runInit migration — agent/category conversion written to destination", () => {
  it("writes agent block for builtin override from agents field", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          agents: { loom: { temperature: 0.2 } },
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
    expect(content).toContain("agent loom {");
    expect(content).toContain("temperature 0.2");
  });

  it("writes agent block for non-colliding custom agent", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          custom_agents: {
            "my-helper": { prompt: "I help.", model: "gpt-4o" },
          },
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
    expect(content).toContain("agent my-helper {");
    expect(content).toContain('prompt "I help."');
    expect(content).toContain('models ["gpt-4o"]');
  });

  it("writes category block from categories field", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          categories: {
            backend: {
              description: "Backend APIs",
              patterns: ["src/api/**"],
            },
          },
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
    expect(content).toContain("category backend {");
    expect(content).toContain('description "Backend APIs"');
    expect(content).toContain('patterns ["src/api/**"]');
  });

  it("builtin collision warning appears in output and file is still written", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          custom_agents: {
            loom: { prompt: "Override loom." }, // collision
            "my-helper": { prompt: "I help." }, // non-collision
          },
        }),
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    const result = await runInit(ctx);
    // Exit 0 even with warnings
    expect(result._unsafeUnwrap()).toBe(0);
    // File is written
    expect(fs.snapshot()["/project/.weave/config.weave"]).toBeDefined();
    // Warning appears in output
    const out = terminal.out.join("\n");
    expect(out).toContain("Migration warnings");
    expect(out).toContain("custom_agents.loom");
    expect(out).toContain("collides with a builtin");
  });

  it("generated file with agents and categories passes parseConfig validation", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": JSON.stringify({
          agents: { loom: { temperature: 0.2 } },
          custom_agents: {
            "my-helper": { prompt: "I help.", mode: "subagent" },
          },
          categories: {
            backend: { patterns: ["src/api/**"] },
          },
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
