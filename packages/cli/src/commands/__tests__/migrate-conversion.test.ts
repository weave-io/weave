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
import { parseConfig } from "@weaveio/weave-core";
import { MemoryFileSystem } from "../../fs/file-system.js";
import { BufferTerminal } from "../../io/terminal.js";
import {
  CONVERSION_REASON,
  MAX_CONVERSION_WARNINGS,
  PATH_DIAGNOSTICS,
  PATH_ENTRY,
  PATH_SOURCE,
  WARNINGS_TRUNCATED_REASON,
} from "../../migration/legacy-conversion-diagnostics.js";
import {
  LEGACY_GRAPH_TOO_LARGE_MESSAGE,
  type LegacyInputCallable,
  type LegacyInputRecord,
  type LegacyInputValue,
  MAX_LEGACY_ARRAY_LENGTH,
  MAX_LEGACY_SOURCE_LENGTH,
  MAX_LEGACY_STRING_LENGTH,
  UNSAFE_LEGACY_GRAPH_MESSAGE,
} from "../../migration/legacy-graph-copy.js";
import { StaticPromptAdapter } from "../../prompt/index.js";
import { ThemeManager } from "../../theme/colors.js";
import {
  type ConversionResult,
  convertLegacyJsonc,
  convertLegacyValue,
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
    expect(result.warnings[0]?.field).toBe("workflows");
    expect(result.warnings[0]?.reason).toContain(
      "not supported in migration v1",
    );
  });

  it("warns and skips legacy continuation section", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ continuation: { recovery: { compaction: true } } }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("continuation");
    expect(result.warnings[0]?.reason).toContain(
      "not supported in migration v1",
    );
  });

  it("warns and skips legacy analytics section", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ analytics: { enabled: true } }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("analytics");
    expect(result.warnings[0]?.reason).toContain(
      "not supported in migration v1",
    );
  });

  it("warns and skips legacy background section", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ background: { enabled: true } }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("background");
    expect(result.warnings[0]?.reason).toContain(
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
    expect(result.warnings[0]?.field).toBe("some_unknown_field");
    expect(result.warnings[0]?.reason).toContain("unknown legacy field");
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
    expect(result.warnings[0]?.field).toBe("<source>");
    expect(result.warnings[0]?.reason).toContain("failed to parse");
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
    expect(result.warnings[0]?.field).toBe("log_level");
    expect(result.warnings[0]?.reason).toContain("not a valid log level");
  });

  it("warns when disabled_agents is not an array", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ disabled_agents: "warp" }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("disabled_agents");
    expect(result.warnings[0]?.reason).toContain("expected an array");
  });

  it("warns when disabled_hooks is not an array", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ disabled_hooks: "hook-name" }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("disabled_hooks");
  });

  it("warns when disabled_skills is not an array", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ disabled_skills: "tdd" }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("disabled_skills");
  });

  it("warns when log_level is not a string", () => {
    const result = convertLegacyJsonc(JSON.stringify({ log_level: 42 }));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("log_level");
    expect(result.warnings[0]?.reason).toContain("expected a string");
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
    expect(result.warnings[0]?.field).toBe("agents.loom.display_name");
    expect(result.warnings[0]?.reason).toContain("not supported");
    // temperature still converted
    expect(result.dsl).toContain("temperature 0.1");
  });

  it("warns when agents value is not an object", () => {
    const result = convertLegacyJsonc(JSON.stringify({ agents: "invalid" }));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("agents");
    expect(result.warnings[0]?.reason).toContain("expected an object");
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
    expect(result.warnings[0]?.field).toBe("agents.my-helper");
    expect(result.warnings[0]?.reason).toContain("not a builtin agent name");
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
    expect(result.warnings[0]?.field).toBe("agents.my-helper");
    expect(result.warnings[0]?.reason).toContain("not a builtin agent name");
    // Builtin is converted
    expect(result.dsl).toContain("agent loom {");
    // Non-builtin is not
    expect(result.dsl).not.toContain("agent my-helper");
  });

  it("warning for non-builtin agents entry mentions custom_agents as the correct path", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ agents: { "my-helper": { temperature: 0.2 } } }),
    );
    expect(result.warnings[0]?.reason).toContain("custom_agents");
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
    expect(result.warnings[0]?.field).toBe("custom_agents.my-agent.mode");
    expect(result.warnings[0]?.reason).toContain("not a valid mode");
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
    expect(result.warnings[0]?.field).toBe("custom_agents.my-agent.skills");
    expect(result.warnings[0]?.reason).toContain("not supported");
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
    expect(result.warnings[0]?.field).toBe("custom_agents.loom");
    expect(result.warnings[0]?.reason).toContain("collides with a builtin");
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
    expect(result.warnings[0]?.field).toBe("custom_agents.tapestry");
    expect(result.warnings[0]?.reason).toContain("collides with a builtin");
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
    const customAgents: LegacyInputRecord = {};
    for (const name of builtins) {
      defineOwn(customAgents, name, { prompt: `Override ${name}.` });
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
      expect(w?.reason).toContain("collides with a builtin");
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
    expect(result.warnings[0]?.field).toBe("custom_agents.loom");
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
    const primaryIdx = modelsLine?.indexOf('"primary-model"') ?? -1;
    const fallbackIdx = modelsLine?.indexOf('"fallback-1"') ?? -1;
    expect(primaryIdx).toBeLessThan(fallbackIdx);
  });

  it("warns when model is not a string", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ agents: { loom: { model: 42 } } }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("agents.loom.model");
    expect(result.warnings[0]?.reason).toContain("expected a string");
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
    expect(result.warnings[0]?.field).toBe("agents.loom.fallback_models");
    expect(result.warnings[0]?.reason).toContain("expected an array");
    // Primary model still converted
    expect(result.dsl).toContain('models ["claude-sonnet-4-5"]');
  });

  it("converts model in category entries", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: {
            description: "Backend APIs",
            patterns: ["src/api/**"],
            model: "gpt-4o",
            fallback_models: ["claude-sonnet-4-5"],
          },
        },
      }),
    );
    expect(result.dsl).toContain('models ["gpt-4o", "claude-sonnet-4-5"]');
    expect(result.dsl).not.toContain("patterns");
  });
});

// 4.5 — Category blocks (no flattened shuttle agents)
describe("convertLegacyJsonc — categories → category blocks", () => {
  it("converts a category into a category block and drops patterns", () => {
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
    expect(result.warnings).toEqual([
      {
        field: "categories.backend.patterns",
        reason:
          "category file patterns are not supported; dropped valid patterns and did not emit a replacement",
      },
    ]);
    expect(result.dsl).toContain("category backend {");
    expect(result.dsl).toContain('description "Backend APIs"');
    expect(result.dsl).not.toContain("patterns");
    expect(parseConfig(result.dsl).isOk()).toBe(true);
  });

  it("does NOT generate a standalone shuttle-backend agent", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: {
            description: "Backend APIs",
            patterns: ["src/api/**"],
          },
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
          backend: {
            description: "Backend APIs",
            patterns: ["src/api/**"],
          },
          frontend: {
            description: "Frontend UI",
            patterns: ["src/components/**"],
          },
        },
      }),
    );
    expect(result.warnings).toHaveLength(2);
    expect(result.dsl).toContain("category backend {");
    expect(result.dsl).toContain("category frontend {");
    expect(result.dsl).not.toContain("patterns");
  });

  it("converts category with temperature and prompt_append", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: {
            description: "Backend APIs",
            patterns: ["src/api/**"],
            temperature: 0.2,
            prompt_append: "Focus on API contracts.",
          },
        },
      }),
    );
    expect(result.dsl).toContain("temperature 0.2");
    expect(result.dsl).toContain('prompt_append "Focus on API contracts."');
    expect(result.dsl).not.toContain("patterns");
    expect(parseConfig(result.dsl).isOk()).toBe(true);
  });

  it("warns on malformed patterns and skips a category without a description", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: { patterns: "src/api/**" },
        },
      }),
    );
    expect(
      result.warnings.some(
        (warning) => warning.field === "categories.backend.patterns",
      ),
    ).toBe(true);
    expect(
      result.warnings.some(
        (warning) => warning.field === "categories.backend.description",
      ),
    ).toBe(true);
    expect(result.dsl).not.toContain("category backend");
  });

  it("converts a category that has a description even when patterns are missing", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          mini: {
            description: "Fast mechanical changes",
            model: "openai/gpt-5.3-codex-spark",
          },
        },
      }),
    );

    expect(result.warnings).toEqual([]);
    expect(result.dsl).toContain("category mini {");
    expect(result.dsl).toContain('description "Fast mechanical changes"');
    expect(result.dsl).not.toContain("patterns");
    expect(parseConfig(result.dsl).isOk()).toBe(true);
  });

  it("warns on malformed pattern entries and skips a category without a description", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          tests: { patterns: [null, 42] },
        },
      }),
    );

    expect(
      result.warnings.some((warning) =>
        warning.field.startsWith("categories.tests.patterns"),
      ),
    ).toBe(true);
    expect(
      result.warnings.some(
        (warning) => warning.field === "categories.tests.description",
      ),
    ).toBe(true);
    expect(result.dsl).not.toContain("category tests");
    expect(parseConfig(result.dsl).isOk()).toBe(true);
  });

  it.each([
    ["a missing", undefined],
    ["an empty", ""],
    ["a whitespace-only", "   "],
  ])("warns and skips a category with %s description", (_, description) => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: { description, patterns: ["src/api/**"] },
        },
      }),
    );

    expect(
      result.warnings.some(
        (warning) =>
          warning.field === "categories.backend.description" &&
          warning.reason === "a non-empty string is required; category skipped",
      ),
    ).toBe(true);
    expect(result.dsl).not.toContain("category backend");
    expect(parseConfig(result.dsl).isOk()).toBe(true);
  });

  it("preserves Mustache-shaped category descriptions verbatim", () => {
    const description = "Literal {{agent.name}} docs";
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          docs: { description, patterns: ["docs/**"] },
        },
      }),
    );

    expect(result.dsl).not.toContain("patterns");
    const parsed = parseConfig(result.dsl);
    expect(parsed.isOk()).toBe(true);
    expect(parsed._unsafeUnwrap().categories.docs?.description).toBe(
      description,
    );
  });

  it("warns when categories value is not an object", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ categories: "invalid" }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("categories");
    expect(result.warnings[0]?.reason).toContain("expected an object");
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
    expect(result.dsl).not.toContain("patterns");
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
    expect(result.warnings[0]?.field).toBe(
      "agents.loom.tools.call_weave_agent",
    );
    expect(result.warnings[0]?.reason).toContain("harness-specific");
  });

  it("warns on ambiguous legacy tool todowrite", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { tools: { todowrite: true } } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("agents.loom.tools.todowrite");
    expect(result.warnings[0]?.reason).toContain("harness-specific");
  });

  it("warns on unknown legacy tool name", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { tools: { some_unknown_tool: true } } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe(
      "agents.loom.tools.some_unknown_tool",
    );
    expect(result.warnings[0]?.reason).toContain("unknown legacy tool name");
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
            description: "Backend APIs",
            patterns: ["src/api/**"],
            tools: { write: true, read: true },
          },
        },
      }),
    );
    expect(result.dsl).toContain("tool_policy {");
    expect(result.dsl).toContain("write allow");
    expect(result.dsl).toContain("read allow");
    expect(result.dsl).not.toContain("patterns");
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
    expect(result.warnings[0]?.field).toBe("agents.loom.prompt_file");
    expect(result.warnings[0]?.reason).toContain("directory components");
    expect(result.dsl).not.toContain("prompt_file");
  });

  it("warns and skips prompt_file with absolute path", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { prompt_file: "/absolute/path/loom.md" } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("agents.loom.prompt_file");
    expect(result.warnings[0]?.reason).toContain("directory components");
    expect(result.dsl).not.toContain("prompt_file");
  });

  it("warns and skips prompt_file with parent directory traversal", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { prompt_file: "../prompts/loom.md" } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("agents.loom.prompt_file");
    expect(result.warnings[0]?.reason).toContain("directory components");
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
    expect(result.warnings[0]?.field).toBe(
      "custom_agents.my-agent.prompt_file",
    );
    expect(result.warnings[0]?.reason).toContain("directory components");
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
    expect(result.dsl).toContain("agent loom {");
    expect(result.dsl).toContain("agent shuttle {");
    expect(result.dsl).toContain("agent my-helper {");
    expect(result.dsl).toContain("category backend {");
    expect(result.dsl).not.toContain("patterns");
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
    const parseResult = parseConfig(result.dsl);
    expect(parseResult.isOk()).toBe(true);
    expect(result.dsl).not.toContain("patterns");
  });

  it("builtin collision warning appears alongside successful non-colliding conversions", () => {
    const source = JSON.stringify({
      custom_agents: {
        loom: { prompt: "Override loom." }, // collision
        "my-helper": { prompt: "I help." }, // non-collision
      },
      categories: {
        backend: {
          description: "Backend APIs",
          patterns: ["src/api/**"],
        },
      },
    });
    const result = convertLegacyJsonc(source);
    expect(
      result.warnings.some((warning) => warning.field === "custom_agents.loom"),
    ).toBe(true);
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
    expect(content).not.toContain("patterns");
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

// ---------------------------------------------------------------------------
// Fix 4 — convertLegacyTools: non-boolean tool permission guard
// ---------------------------------------------------------------------------

describe("convertLegacyJsonc — non-boolean tool permission guard", () => {
  it("warns and skips tool entry with string permission value", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { tools: { write: "yes" } } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("agents.loom.tools.write");
    expect(result.warnings[0]?.reason).toContain(
      "tool permission must be a boolean",
    );
    expect(result.dsl).not.toContain("tool_policy");
  });

  it("warns and skips tool entry with number permission value", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { tools: { bash: 1 } } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("agents.loom.tools.bash");
    expect(result.warnings[0]?.reason).toContain(
      "tool permission must be a boolean",
    );
    expect(result.dsl).not.toContain("execute");
  });

  it("warns and skips tool entry with null permission value", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { tools: { read: null } } },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("agents.loom.tools.read");
    expect(result.warnings[0]?.reason).toContain(
      "tool permission must be a boolean",
    );
  });

  it("converts boolean tools while warning on non-boolean ones", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: {
          loom: {
            tools: {
              write: true, // valid boolean
              bash: "yes", // invalid non-boolean
              read: false, // valid boolean
            },
          },
        },
      }),
    );
    // One warning for the non-boolean
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("agents.loom.tools.bash");
    // Valid boolean tools are still converted
    expect(result.dsl).toContain("write allow");
    expect(result.dsl).toContain("read deny");
    // Non-boolean tool is not converted
    expect(result.dsl).not.toContain("execute");
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — JSONC parser: URL preservation in string literals
// ---------------------------------------------------------------------------

describe("convertLegacyJsonc — URL preservation in string literals", () => {
  it("preserves https:// URLs inside string values", () => {
    const source = `{ "model": "https://api.example.com/v1/model" }`;
    const result = convertLegacyJsonc(source);
    // Should parse without error (unknown field warning is fine)
    expect(result.warnings.some((w) => w.field === "<source>")).toBe(false);
  });

  it("preserves http:// URLs inside string values without stripping them", () => {
    const source = `{ "prompt_append": "See http://example.com for details." }`;
    // This will produce an unknown field warning, but the source must parse
    const result = convertLegacyJsonc(source);
    expect(result.warnings.some((w) => w.field === "<source>")).toBe(false);
  });

  it("preserves // inside string values (not treated as line comment)", () => {
    const source = `{ "log_level": "INFO" /* block */ }`;
    const result = convertLegacyJsonc(source);
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("log_level INFO");
  });

  it("strips line comment after value while preserving string with // inside", () => {
    // The string value contains // but the trailing // is a real comment
    const source = `{\n  "log_level": "INFO" // trailing comment\n}`;
    const result = convertLegacyJsonc(source);
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("log_level INFO");
  });

  it("strips block comment while preserving adjacent string values", () => {
    const source = `/* header */ { "log_level": "DEBUG" /* inline */ }`;
    const result = convertLegacyJsonc(source);
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("log_level DEBUG");
  });

  it("handles escaped quotes inside strings without breaking comment detection", () => {
    const source = `{ "prompt_append": "Say \\"hello\\"." }`;
    const result = convertLegacyJsonc(source);
    // unknown field warning is expected; source must parse successfully
    expect(result.warnings.some((w) => w.field === "<source>")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// escapeForDsl — control character escaping
// ---------------------------------------------------------------------------

describe("convertLegacyJsonc — control character escaping in string fields", () => {
  it("escapes newline in prompt to \\n", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: { "my-agent": { prompt: "line1\nline2" } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('prompt "line1\\nline2"');
  });

  it("escapes carriage return in prompt to \\r", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: { "my-agent": { prompt: "line1\rline2" } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('prompt "line1\\rline2"');
  });

  it("escapes tab in prompt to \\t", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: { "my-agent": { prompt: "col1\tcol2" } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('prompt "col1\\tcol2"');
  });

  it("escapes backslash in prompt to \\\\", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: { "my-agent": { prompt: "path\\to\\file" } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('prompt "path\\\\to\\\\file"');
  });

  it('escapes double-quote in prompt to \\"', () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: { "my-agent": { prompt: 'say "hello"' } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain('prompt "say \\"hello\\""');
  });

  it("escapes NUL byte (\\x00) in prompt to \\u0000", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: { "my-agent": { prompt: "before\x00after" } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("\\u0000");
  });

  it("escapes BEL (\\x07) in prompt to \\u0007", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: { "my-agent": { prompt: "ring\x07bell" } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("\\u0007");
  });

  it("escapes ESC (\\x1b) in prompt to \\u001b", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: { "my-agent": { prompt: "\x1b[31mred\x1b[0m" } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("\\u001b");
  });

  it("escapes DEL (\\x7f) in prompt to \\u007f", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: { "my-agent": { prompt: "before\x7fafter" } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("\\u007f");
  });

  it("escapes control characters in prompt_append", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { prompt_append: "note\x01hidden" } },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.dsl).toContain("\\u0001");
  });

  it("escapes control characters in category description", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: {
            description: "APIs\x02services",
            patterns: ["src/api/**"],
          },
        },
      }),
    );
    expect(result.dsl).toContain("\\u0002");
    expect(result.dsl).not.toContain("patterns");
  });

  it("generated DSL with escaped control characters passes parseConfig validation", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          "my-agent": { prompt: "line1\nline2\ttabbed\x00null" },
        },
      }),
    );
    expect(result.warnings).toHaveLength(0);
    const parseResult = parseConfig(result.dsl);
    expect(parseResult.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression — real-world JSONC with comments AND trailing commas
//
// `JSON.parse` rejected valid JSONC trailing commas. Conversion then returned
// an empty DSL body, so migration wrote the starter models instead of the
// legacy agent model overrides.
// ---------------------------------------------------------------------------

describe("convertLegacyJsonc — real-world JSONC trailing commas and comments (regression)", () => {
  // Mirrors the shape of a real legacy weave-opencode.jsonc: a leading block
  // comment, inline line comments, and trailing commas after the last
  // property in both a nested object (modelOptions) and its enclosing
  // agent block, plus a trailing comma after the whole "agents" block.
  const jsoncWithCommentsAndTrailingCommas = `{
  /* legacy weave-opencode config */
  "log_level": "INFO", // project log level
  "agents": {
    "loom": {
      "model": "openai/gpt-5.6-sol", // primary orchestrator model
      "temperature": 0.1
    },
    "spindle": {
      "model": "openai/gpt-5.6-luna",
      "modelOptions": {
        "reasoningEffort": "xhigh"
      },
    },
  },
}`;

  it("parses without a <source> failure warning", () => {
    const result = convertLegacyJsonc(jsoncWithCommentsAndTrailingCommas);
    expect(result.warnings.some((w) => w.field === "<source>")).toBe(false);
  });

  it("preserves builtin agent model overrides through the converter", () => {
    const result = convertLegacyJsonc(jsoncWithCommentsAndTrailingCommas);
    expect(result.dsl).toContain("agent loom {");
    expect(result.dsl).toContain('models ["openai/gpt-5.6-sol"]');
    expect(result.dsl).toContain("agent spindle {");
    expect(result.dsl).toContain('models ["openai/gpt-5.6-luna"]');
    expect(result.dsl).toContain("log_level INFO");
  });

  it("converted DSL from the comments+trailing-comma fixture passes parseConfig validation", () => {
    const { dsl } = convertLegacyJsonc(jsoncWithCommentsAndTrailingCommas);
    const parseResult = parseConfig(dsl);
    expect(parseResult.isOk()).toBe(true);
  });

  it("survives the full migration write seam: builtin agent models land in config.weave", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc":
          jsoncWithCommentsAndTrailingCommas,
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
    // The bug regressed to the starter-config fallback (no migrated agent
    // overrides at all); assert the actual builtin model values survived.
    expect(content).toContain("agent loom {");
    expect(content).toContain('models ["openai/gpt-5.6-sol"]');
    expect(content).toContain("agent spindle {");
    expect(content).toContain('models ["openai/gpt-5.6-luna"]');
  });

  it("still rejects genuinely malformed JSON (invalid-input warning behavior preserved)", () => {
    const result = convertLegacyJsonc("{ invalid json !!!");
    expect(result.dsl).toBe("");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("<source>");
    expect(result.warnings[0]?.reason).toContain("failed to parse");
  });
});

describe("convertLegacyJsonc — string trigger conversion", () => {
  it("converts structured triggers using routing_hint else trigger, preserving order and exact dedupe", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: {
          loom: {
            triggers: [
              {
                domain: "Review",
                trigger: "Review code",
                routing_hint: "Use for pull request review",
              },
              { domain: "Tests", trigger: "Fix tests" },
              {
                domain: "Review",
                trigger: "Duplicate",
                routing_hint: "Use for pull request review",
              },
            ],
          },
        },
      }),
    );
    expect(result.dsl).toContain(
      'triggers ["Use for pull request review", "Fix tests"]',
    );
    expect(result.dsl).not.toMatch(/domain\s+"/);
    expect(result.dsl).not.toContain("routing_hint");
    expect(
      result.warnings.some((warning) =>
        warning.field.includes("agents.loom.triggers.0.domain"),
      ),
    ).toBe(true);
    expect(parseConfig(result.dsl).isOk()).toBe(true);
  });

  it("warns for empty, malformed, and non-array trigger entries", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          helper: {
            prompt: "Help",
            triggers: ["Keep me", "", "   ", 42, null, { trigger: "" }],
          },
        },
      }),
    );
    expect(result.dsl).toContain('triggers ["Keep me"]');
    expect(
      result.warnings.some((warning) =>
        warning.reason.includes("empty trigger string discarded"),
      ),
    ).toBe(true);
    expect(
      result.warnings.some((warning) =>
        warning.reason.includes("malformed trigger entry discarded"),
      ),
    ).toBe(true);
  });

  it("converts category triggers and never emits trigger objects or fast aliases", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          backend: {
            description: "Backend APIs",
            triggers: [
              { trigger: "Use for APIs", domain: "API" },
              "Use for persistence",
            ],
            fast: true,
            service_class: "priority",
            speed: "fast",
            variant: "turbo",
            priority: "high",
          },
        },
      }),
    );
    expect(result.dsl).toContain(
      'triggers ["Use for APIs", "Use for persistence"]',
    );
    expect(result.dsl).not.toContain("fast");
    expect(result.dsl).not.toContain("service_class");
    expect(result.dsl).not.toContain("speed");
    expect(result.dsl).not.toContain("variant");
    expect(result.dsl).not.toContain("priority");
    expect(
      result.warnings.some((warning) => warning.field.endsWith(".fast")),
    ).toBe(true);
    expect(parseConfig(result.dsl).isOk()).toBe(true);
  });
});

describe("convertLegacyValue — descriptor-safe conversion", () => {
  it("does not execute getters on crafted objects", () => {
    let getterExecutions = 0;
    const input: LegacyInputRecord = {};
    Object.defineProperty(input, "log_level", {
      enumerable: true,
      configurable: true,
      get() {
        getterExecutions += 1;
        return "DEBUG";
      },
    });

    const result = convertLegacyValue(input);
    expect(getterExecutions).toBe(0);
    expect(result.dsl).toBe("");
    expect(result.warnings[0]?.reason).toBe(UNSAFE_LEGACY_GRAPH_MESSAGE);
  });

  it("does not read inherited properties", () => {
    let inheritedGetterExecutions = 0;
    Object.defineProperty(Object.prototype, "log_level", {
      enumerable: true,
      configurable: true,
      get() {
        inheritedGetterExecutions += 1;
        return "DEBUG";
      },
    });
    try {
      const result = convertLegacyValue({ agents: {} });
      expect(inheritedGetterExecutions).toBe(0);
      expect(result.dsl).not.toContain("log_level");
    } finally {
      Reflect.deleteProperty(Object.prototype, "log_level");
    }
  });

  it("rejects callable values without executing getters", () => {
    let getterExecutions = 0;
    const callable: LegacyInputCallable = () => void 0;
    Object.defineProperty(callable, "log_level", {
      enumerable: true,
      configurable: true,
      get() {
        getterExecutions += 1;
        return "DEBUG";
      },
    });

    const result = convertLegacyValue(callable);
    expect(getterExecutions).toBe(0);
    expect(result.dsl).toBe("");
    expect(result.warnings[0]?.reason).toBe(UNSAFE_LEGACY_GRAPH_MESSAGE);
  });

  it("rejects cycles without throwing", () => {
    const input: LegacyInputRecord = {};
    const agents: LegacyInputRecord = {};
    defineOwn(input, "agents", agents);
    defineOwn(agents, "loom", input);

    const result = convertLegacyValue(input);
    expect(result.dsl).toBe("");
    expect(result.warnings[0]?.reason).toBe(UNSAFE_LEGACY_GRAPH_MESSAGE);
  });

  it("rejects oversized arrays without throwing", () => {
    const result = convertLegacyValue({
      disabled_agents: Array.from(
        { length: MAX_LEGACY_ARRAY_LENGTH + 1 },
        (_, index) => `agent-${index}`,
      ),
    });
    expect(result.dsl).toBe("");
    expect(result.warnings[0]?.reason).toBe(LEGACY_GRAPH_TOO_LARGE_MESSAGE);
  });

  it("rejects sparse arrays without executing getters", () => {
    let getterExecutions = 0;
    const sparse: LegacyInputValue[] = [];
    sparse[1] = "loom";
    Object.defineProperty(sparse, "0", {
      enumerable: true,
      configurable: true,
      get() {
        getterExecutions += 1;
        return "warp";
      },
    });

    const result = convertLegacyValue({ disabled_agents: sparse });
    expect(getterExecutions).toBe(0);
    expect(result.dsl).toBe("");
    expect(result.warnings[0]?.reason).toBe(UNSAFE_LEGACY_GRAPH_MESSAGE);
  });

  it("rejects nested trigger getters without executing them", () => {
    let getterExecutions = 0;
    const trigger: LegacyInputRecord = {};
    Object.defineProperty(trigger, "routing_hint", {
      enumerable: true,
      configurable: true,
      get() {
        getterExecutions += 1;
        return "Use for review";
      },
    });

    const result = convertLegacyValue({
      agents: { loom: { triggers: [trigger] } },
    });
    expect(getterExecutions).toBe(0);
    expect(result.dsl).toBe("");
    expect(result.warnings[0]?.reason).toBe(UNSAFE_LEGACY_GRAPH_MESSAGE);
  });

  it("falls back from blank routing_hint to trigger and warns for discarded fields", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: {
          loom: {
            triggers: [
              {
                routing_hint: "   ",
                trigger: "Review code",
                domain: "Review",
              },
            ],
          },
        },
      }),
    );
    expect(result.dsl).toContain('triggers ["Review code"]');
    expect(
      result.warnings.some((warning) =>
        warning.field.includes("agents.loom.triggers.0.routing_hint"),
      ),
    ).toBe(true);
    expect(
      result.warnings.some((warning) =>
        warning.field.includes("agents.loom.triggers.0.domain"),
      ),
    ).toBe(true);
    expect(parseConfig(result.dsl).isOk()).toBe(true);
  });
});

function defineOwn(
  target: LegacyInputRecord,
  key: string,
  value: LegacyInputValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function createInputRecord(): LegacyInputRecord {
  return Object.create(null);
}

function warningBlob(result: ConversionResult): string {
  return `${result.dsl}\n${JSON.stringify(result.warnings)}`;
}

describe("convertLegacyJsonc — prototype-safe membership checks", () => {
  it("warns on top-level toString, constructor, and __proto__ without throwing", () => {
    const root = createInputRecord();
    defineOwn(root, "toString", "secret-toString");
    defineOwn(root, "constructor", "secret-constructor");
    defineOwn(root, "__proto__", "secret-proto");

    const result = convertLegacyValue(root);
    expect(result.dsl).toBe("");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.every((warning) => warning.reason.length > 0)).toBe(
      true,
    );
    const blob = warningBlob(result);
    expect(blob).not.toContain("[native code]");
    expect(blob).not.toContain("function ");
    expect(blob).not.toContain("secret-toString");
    expect(blob).not.toContain("secret-constructor");
    expect(blob).not.toContain("secret-proto");
  });

  it("warns on nested map toString, constructor, and __proto__ without throwing", () => {
    const root = createInputRecord();
    const agents = createInputRecord();
    const inner = createInputRecord();
    defineOwn(inner, "temperature", 0.1);
    defineOwn(agents, "toString", inner);
    defineOwn(agents, "constructor", inner);
    defineOwn(agents, "__proto__", inner);
    defineOwn(root, "agents", agents);

    const result = convertLegacyValue(root);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(warningBlob(result)).not.toContain("[native code]");
    expect(warningBlob(result)).not.toContain("function ");
    if (result.dsl.length > 0) {
      expect(parseConfig(result.dsl).isOk()).toBe(true);
    }
  });

  it("does not emit prototype methods as tool_policy capabilities", () => {
    const root = createInputRecord();
    const agents = createInputRecord();
    const loom = createInputRecord();
    const tools = createInputRecord();
    defineOwn(tools, "toString", true);
    defineOwn(tools, "constructor", false);
    defineOwn(tools, "__proto__", true);
    defineOwn(loom, "tools", tools);
    defineOwn(agents, "loom", loom);
    defineOwn(root, "agents", agents);

    const result = convertLegacyValue(root);
    expect(result.dsl).not.toContain("[native code]");
    expect(result.dsl).not.toContain("function ");
    expect(result.dsl).not.toContain("tool_policy");
    expect(warningBlob(result)).not.toContain("[native code]");
    if (result.dsl.length > 0) {
      expect(parseConfig(result.dsl).isOk()).toBe(true);
    }
  });
});

describe("convertLegacyJsonc — identifier validation before emission", () => {
  it("rejects injection-shaped custom agent names and keeps sibling valid agents", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          'helper} agent evil { prompt "injected"': { prompt: "ok" },
          "ok-agent": { prompt: "safe" },
        },
      }),
    );
    expect(result.dsl).toContain("agent ok-agent {");
    expect(result.dsl).toContain('prompt "safe"');
    expect(result.dsl).not.toContain("injected");
    expect(result.dsl).not.toContain("agent evil");
    expect(result.dsl).not.toContain("helper}");
    expect(
      result.warnings.some(
        (warning) => warning.reason === CONVERSION_REASON.invalidIdentifier,
      ),
    ).toBe(true);
    expect(parseConfig(result.dsl).isOk()).toBe(true);
  });

  it("rejects category names with braces, newlines, and control characters", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        categories: {
          'backend}\nagent evil { prompt "pwn"': { description: "Backend" },
          "has\nnewline": { description: "Docs" },
          "ok-cat": { description: "Keep me" },
        },
      }),
    );
    expect(result.dsl).toContain("category ok-cat {");
    expect(result.dsl).not.toContain("agent evil");
    expect(result.dsl).not.toContain("pwn");
    expect(
      result.warnings.filter(
        (warning) => warning.reason === CONVERSION_REASON.invalidIdentifier,
      ).length,
    ).toBeGreaterThan(0);
    expect(parseConfig(result.dsl).isOk()).toBe(true);
  });

  it("rejects dangerous custom agent names", () => {
    const result = convertLegacyJsonc(
      '{"custom_agents":{"constructor":{"prompt":"x"},"prototype":{"prompt":"x"},"__proto__":{"prompt":"x"}}}',
    );
    expect(result.dsl).not.toContain("agent constructor");
    expect(result.dsl).not.toContain("agent prototype");
    expect(result.dsl).not.toContain("agent __proto__");
    expect(
      result.warnings.some((warning) => warning.reason.includes("dangerous")),
    ).toBe(true);
  });

  it("rejects long names with a bounded warning path", () => {
    const longName = `a${"b".repeat(300)}`;
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: { [longName]: { prompt: "x" } },
      }),
    );
    expect(result.dsl).not.toContain(longName);
    expect(
      result.warnings.some(
        (warning) =>
          warning.field.includes(PATH_ENTRY) &&
          warning.reason === CONVERSION_REASON.invalidIdentifier,
      ),
    ).toBe(true);
    expect(JSON.stringify(result.warnings)).not.toContain(longName);
  });
});

describe("convertLegacyJsonc — emitted scalar validation", () => {
  it("omits NaN temperature from the direct value seam", () => {
    const root = createInputRecord();
    const agents = createInputRecord();
    const loom = createInputRecord();
    defineOwn(loom, "temperature", Number.NaN);
    defineOwn(agents, "loom", loom);
    defineOwn(root, "agents", agents);

    const result = convertLegacyValue(root);
    expect(result.dsl).not.toContain("NaN");
    expect(
      result.warnings.some(
        (warning) =>
          warning.field === "agents.loom.temperature" &&
          warning.reason.includes("temperature"),
      ),
    ).toBe(true);
    if (result.dsl.length > 0) {
      expect(parseConfig(result.dsl).isOk()).toBe(true);
    }
  });

  it("omits Infinity temperature from the direct value seam", () => {
    const root = createInputRecord();
    const agents = createInputRecord();
    const loom = createInputRecord();
    defineOwn(loom, "temperature", Number.POSITIVE_INFINITY);
    defineOwn(agents, "loom", loom);
    defineOwn(root, "agents", agents);

    const result = convertLegacyValue(root);
    expect(result.dsl).not.toContain("Infinity");
    expect(
      result.warnings.some((warning) =>
        warning.reason.includes("non_finite_number"),
      ),
    ).toBe(true);
    if (result.dsl.length > 0) {
      expect(parseConfig(result.dsl).isOk()).toBe(true);
    }
  });

  it("omits out-of-range temperature instead of returning invalid DSL", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ agents: { loom: { temperature: 9.9 } } }),
    );
    expect(result.dsl).not.toContain("9.9");
    expect(
      result.warnings.some(
        (warning) => warning.field === "agents.loom.temperature",
      ),
    ).toBe(true);
    if (result.dsl.length > 0) {
      expect(parseConfig(result.dsl).isOk()).toBe(true);
    }
  });

  it("omits invalid model thinking suffixes instead of emitting them", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { model: "gpt-4o#not-a-level" } },
      }),
    );
    expect(result.dsl).not.toContain("not-a-level");
    expect(
      result.warnings.some(
        (warning) => warning.reason === CONVERSION_REASON.invalidModel,
      ),
    ).toBe(true);
    if (result.dsl.length > 0) {
      expect(parseConfig(result.dsl).isOk()).toBe(true);
    }
  });
});

describe("convertLegacyJsonc — duplicate JSONC keys", () => {
  it("detects duplicate top-level fields and agent names before collapse", () => {
    const result = convertLegacyJsonc(
      `{ "log_level": "INFO", "log_level": "DEBUG", "agents": { "loom": { "temperature": 0.1 }, "loom": { "temperature": 0.9 } } }`,
    );
    expect(result.dsl).toBe("");
    expect(
      result.warnings.some(
        (warning) =>
          warning.field === "log_level" &&
          warning.reason === CONVERSION_REASON.duplicateKey,
      ),
    ).toBe(true);
    expect(
      result.warnings.some(
        (warning) =>
          warning.field === "agents.loom" &&
          warning.reason === CONVERSION_REASON.duplicateKey,
      ),
    ).toBe(true);
    expect(result.dsl).not.toContain("DEBUG");
    expect(result.dsl).not.toContain("0.9");
  });

  it("detects duplicate category names before collapse", () => {
    const result = convertLegacyJsonc(
      `{ "categories": { "backend": { "description": "A" }, "backend": { "description": "B" } } }`,
    );
    expect(result.dsl).toBe("");
    expect(
      result.warnings.some(
        (warning) =>
          warning.field === "categories.backend" &&
          warning.reason === CONVERSION_REASON.duplicateKey,
      ),
    ).toBe(true);
  });
});

describe("convertLegacyJsonc — sanitized warnings and bounds", () => {
  it("does not echo secret-shaped strings from discarded fields, paths, names, modes, or invalid values", () => {
    const secret = "sk-live-SUPERSECRETVALUE-12345";
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: {
          loom: {
            triggers: [
              {
                routing_hint: "Use for review",
                domain: secret,
                trigger: "x",
                api_key: secret,
              },
            ],
            prompt_file: `../secrets/${secret}.md`,
            display_name: secret,
          },
        },
        custom_agents: {
          [`helper} ${secret}`]: { prompt: "x", mode: secret },
        },
      }),
    );
    const blob = warningBlob(result);
    expect(blob).not.toContain(secret);
    expect(result.dsl).toContain('triggers ["Use for review"]');
    expect(parseConfig(result.dsl).isOk()).toBe(true);
  });

  it("bounds huge source text with a deterministic warning", () => {
    const result = convertLegacyJsonc("{".repeat(MAX_LEGACY_SOURCE_LENGTH + 1));
    expect(result.dsl).toBe("");
    expect(result.warnings[0]?.field).toBe(PATH_SOURCE);
    expect(result.warnings[0]?.reason).toBe(CONVERSION_REASON.sourceTooLarge);
    expect(result.warnings[0]?.reason.length).toBeLessThanOrEqual(512);
  });

  it("bounds huge warning sets with a truncation marker", () => {
    const fields: Record<string, string> = {};
    for (let index = 0; index < MAX_CONVERSION_WARNINGS + 8; index += 1) {
      fields[`unknown_field_${index}`] = "x";
    }
    const result = convertLegacyJsonc(JSON.stringify(fields));
    expect(result.warnings.length).toBeLessThanOrEqual(MAX_CONVERSION_WARNINGS);
    expect(
      result.warnings.some(
        (warning) =>
          warning.field === PATH_DIAGNOSTICS &&
          warning.reason === WARNINGS_TRUNCATED_REASON,
      ),
    ).toBe(true);
    expect(JSON.stringify(result.warnings).length).toBeLessThanOrEqual(
      8 * 1024 + 256,
    );
  });

  it("bounds huge keys without echoing them", () => {
    const hugeKey = "k".repeat(MAX_LEGACY_STRING_LENGTH + 8);
    const root = createInputRecord();
    defineOwn(root, hugeKey, "value");
    const result = convertLegacyValue(root);
    expect(result.dsl).toBe("");
    expect(result.warnings[0]?.reason).toBe(LEGACY_GRAPH_TOO_LARGE_MESSAGE);
    expect(JSON.stringify(result.warnings)).not.toContain(hugeKey.slice(0, 64));
  });

  it("returns parseConfig-valid DSL or omits the invalid block", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { temperature: 0.2 } },
        custom_agents: {
          "bad} name": { prompt: "nope" },
          helper: { prompt: "ok", temperature: 9.9 },
        },
      }),
    );
    expect(result.dsl).toContain("agent loom {");
    expect(result.dsl).toContain("agent helper {");
    expect(result.dsl).not.toContain("bad} name");
    expect(result.dsl).not.toContain("9.9");
    expect(parseConfig(result.dsl).isOk()).toBe(true);
  });
});
