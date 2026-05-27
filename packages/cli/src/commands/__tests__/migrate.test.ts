/**
 * migrate.test.ts — Task 2 write-path tests for migration planning, preflight,
 * validation-before-write, backup creation, provenance comments, source
 * preservation, and non-interactive --yes success paths.
 *
 * All tests use MemoryFileSystem and StaticPromptAdapter — no real filesystem
 * or harness processes are involved.
 */

import { describe, expect, it } from "bun:test";
import { MemoryFileSystem } from "../../fs/file-system.js";
import { BufferTerminal } from "../../io/terminal.js";
import { StaticPromptAdapter } from "../../prompt/index.js";
import { ThemeManager } from "../../theme/colors.js";
import { type MigrationPlan, runInit, writeMigratedDsl } from "../init.js";

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

// ---------------------------------------------------------------------------
// 2.1 / 2.2 — Migration plan stage and interactive preflight summary
// ---------------------------------------------------------------------------

describe("migration preflight summary", () => {
  it("shows source path in preflight output", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
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
    expect(out).toContain("/project/.opencode/weave-opencode.jsonc");
  });

  it("shows destination path in preflight output", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const prompt = new StaticPromptAdapter({ confirm: [false] });
    const { terminal, ctx } = migrateContext({
      fs,
      prompt,
      overrides: { initSubmode: "migrate", scope: "local" },
    });
    await runInit(ctx);
    const out = terminal.out.join("\n");
    expect(out).toContain("/project/.weave/config.weave");
  });

  it("shows destination-exists status (no overwrite) in preflight", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const prompt = new StaticPromptAdapter({ confirm: [false] });
    const { terminal, ctx } = migrateContext({
      fs,
      prompt,
      overrides: { initSubmode: "migrate", scope: "local" },
    });
    await runInit(ctx);
    const out = terminal.out.join("\n");
    expect(out).toContain("destination does not exist");
  });

  it("shows backup intent when destination already exists", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
        "/project/.weave/config.weave": "# existing config",
      },
      "/project",
      "/home/user",
    );
    const prompt = new StaticPromptAdapter({ confirm: [false] });
    const { terminal, ctx } = migrateContext({
      fs,
      prompt,
      overrides: { initSubmode: "migrate", scope: "local" },
    });
    await runInit(ctx);
    const out = terminal.out.join("\n");
    expect(out).toContain("backup will be created");
    expect(out).toContain(".bak");
  });

  it("shows skipped-warning count of zero when no fields are skipped", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const prompt = new StaticPromptAdapter({ confirm: [false] });
    const { terminal, ctx } = migrateContext({
      fs,
      prompt,
      overrides: { initSubmode: "migrate", scope: "local" },
    });
    await runInit(ctx);
    const out = terminal.out.join("\n");
    // Skipped fields line should show "none" when count is 0
    expect(out).toContain("Skipped fields");
    expect(out).toContain("none");
  });

  it("preflight appears before any file mutation (no destination written on decline)", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const prompt = new StaticPromptAdapter({ confirm: [false] }); // decline
    const { terminal, ctx } = migrateContext({
      fs,
      prompt,
      overrides: { initSubmode: "migrate", scope: "local" },
    });
    await runInit(ctx);
    // Preflight was shown
    expect(terminal.out.join("\n")).toContain("Migration preflight");
    // No destination written
    const snap = fs.snapshot();
    expect(snap["/project/.weave/config.weave"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2.3 — Validation before write: abort on invalid DSL
//
// These tests call writeMigratedDsl() directly so they can inject arbitrary
// DSL — including intentionally invalid DSL — without going through the full
// runInit() flow. This gives direct, unambiguous evidence that the
// parseConfig() gate fires before any destination or backup file is touched.
// ---------------------------------------------------------------------------

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

/** Minimal valid DSL that passes parseConfig(). */
const VALID_DSL = `settings {\n  log_level INFO\n}\n`;

/** Syntactically broken DSL that parseConfig() must reject. */
const INVALID_DSL_SYNTAX = `agent { UNCLOSED BLOCK`;

/**
 * Structurally invalid DSL: valid syntax but fails Zod schema validation.
 * `prompt` and `prompt_file` are mutually exclusive — the schema rejects this.
 */
const INVALID_DSL_SCHEMA = `agent myagent {\n  prompt "hello"\n  prompt_file "foo.md"\n}\n`;

describe("validation-before-write", () => {
  // --- Happy path: valid DSL is written ---

  it("valid DSL passes parseConfig() and destination is written", async () => {
    const fs = new MemoryFileSystem({}, "/project", "/home/user");
    const plan = makePlan(fs);
    const result = await writeMigratedDsl(fs, plan, VALID_DSL, false);
    expect(result.isOk()).toBe(true);
    expect(fs.snapshot()["/project/.weave/config.weave"]).toBe(VALID_DSL);
  });

  it("generated DSL from runInit passes the normal parse/validation pipeline", async () => {
    // End-to-end: the starter config produced by buildMigratedContent must be valid DSL.
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
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
    // File was written — validation passed
    expect(fs.snapshot()["/project/.weave/config.weave"]).toBeDefined();
  });

  // --- Validation gate: invalid DSL aborts before any file mutation ---

  it("syntactically invalid DSL aborts before destination is written (no destination)", async () => {
    const fs = new MemoryFileSystem({}, "/project", "/home/user");
    const plan = makePlan(fs);
    const result = await writeMigratedDsl(fs, plan, INVALID_DSL_SYNTAX, false);
    // Must return an error
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain(
      "Generated DSL failed validation",
    );
    // Destination must NOT be created
    expect(fs.snapshot()["/project/.weave/config.weave"]).toBeUndefined();
  });

  it("syntactically invalid DSL aborts before destination is mutated (destination exists)", async () => {
    const existingContent = "# pre-existing config";
    const fs = new MemoryFileSystem(
      { "/project/.weave/config.weave": existingContent },
      "/project",
      "/home/user",
    );
    const plan = makePlan(fs);
    const result = await writeMigratedDsl(fs, plan, INVALID_DSL_SYNTAX, true);
    expect(result.isErr()).toBe(true);
    // Destination must remain byte-for-byte identical
    expect(fs.snapshot()["/project/.weave/config.weave"]).toBe(existingContent);
  });

  it("syntactically invalid DSL aborts before backup is created (destination exists)", async () => {
    const existingContent = "# pre-existing config";
    const fs = new MemoryFileSystem(
      { "/project/.weave/config.weave": existingContent },
      "/project",
      "/home/user",
    );
    const plan = makePlan(fs);
    const result = await writeMigratedDsl(fs, plan, INVALID_DSL_SYNTAX, true);
    expect(result.isErr()).toBe(true);
    // Backup must NOT be created — validation fires before the copy step
    expect(fs.snapshot()["/project/.weave/config.weave.bak"]).toBeUndefined();
  });

  it("schema-invalid DSL aborts before destination is written (no destination)", async () => {
    const fs = new MemoryFileSystem({}, "/project", "/home/user");
    const plan = makePlan(fs);
    const result = await writeMigratedDsl(fs, plan, INVALID_DSL_SCHEMA, false);
    expect(result.isErr()).toBe(true);
    expect(fs.snapshot()["/project/.weave/config.weave"]).toBeUndefined();
  });

  it("schema-invalid DSL aborts before backup is created (destination exists)", async () => {
    const existingContent = "# pre-existing config";
    const fs = new MemoryFileSystem(
      { "/project/.weave/config.weave": existingContent },
      "/project",
      "/home/user",
    );
    const plan = makePlan(fs);
    const result = await writeMigratedDsl(fs, plan, INVALID_DSL_SCHEMA, true);
    expect(result.isErr()).toBe(true);
    // Neither destination nor backup mutated
    expect(fs.snapshot()["/project/.weave/config.weave"]).toBe(existingContent);
    expect(fs.snapshot()["/project/.weave/config.weave.bak"]).toBeUndefined();
  });

  // --- Earlier abort path: no legacy source (kept for regression coverage) ---

  it("missing legacy source aborts before destination is mutated", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.weave/config.weave": "# pre-existing config",
      },
      "/project",
      "/home/user",
    );
    // No legacy source → migration fails before any write
    const { terminal, ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("No legacy config found");
    // Destination must remain untouched
    expect(fs.snapshot()["/project/.weave/config.weave"]).toBe(
      "# pre-existing config",
    );
    // No backup created
    expect(fs.snapshot()["/project/.weave/config.weave.bak"]).toBeUndefined();
  });

  it("missing legacy source aborts before backup is created (destination exists)", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.weave/config.weave": "# pre-existing config",
        // No legacy source
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    // Backup must NOT be created since migration aborted before write
    expect(fs.snapshot()["/project/.weave/config.weave.bak"]).toBeUndefined();
    // Original destination must be unchanged
    expect(fs.snapshot()["/project/.weave/config.weave"]).toBe(
      "# pre-existing config",
    );
  });
});

// ---------------------------------------------------------------------------
// 2.4 — Overwrite backup creation
// ---------------------------------------------------------------------------

describe("overwrite backup creation", () => {
  it("writes exactly one .bak file when destination exists", async () => {
    const existingContent =
      '# existing weave config\nagent old { prompt "old" }';
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
        "/project/.weave/config.weave": existingContent,
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    const snap = fs.snapshot();
    // Exactly one backup file
    expect(snap["/project/.weave/config.weave.bak"]).toBe(existingContent);
    // No double-backup or extra files
    const backupKeys = Object.keys(snap).filter((k) => k.endsWith(".bak"));
    expect(backupKeys).toHaveLength(1);
  });

  it("backup contains the previous destination content", async () => {
    const previousContent = "# previous config content";
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
        "/project/.weave/config.weave": previousContent,
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    expect(fs.snapshot()["/project/.weave/config.weave.bak"]).toBe(
      previousContent,
    );
  });

  it("destination is overwritten with migrated content after backup", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
        "/project/.weave/config.weave": "# old content",
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    const snap = fs.snapshot();
    // New content has provenance comment
    expect(snap["/project/.weave/config.weave"]).toContain(
      "Migrated from legacy OpenCode JSONC config",
    );
    // Old content is in backup
    expect(snap["/project/.weave/config.weave.bak"]).toBe("# old content");
  });

  it("no backup file created when destination does not exist", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    const snap = fs.snapshot();
    const backupKeys = Object.keys(snap).filter((k) => k.endsWith(".bak"));
    expect(backupKeys).toHaveLength(0);
  });

  it("success message mentions backup when one was created", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
        "/project/.weave/config.weave": "# old",
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    expect(terminal.out.join("\n")).toContain("Backup:");
  });

  it("success message does not mention backup when none was created", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    expect(terminal.out.join("\n")).not.toContain("Backup:");
  });
});

// ---------------------------------------------------------------------------
// 2.5 — Source preservation
// ---------------------------------------------------------------------------

describe("source preservation", () => {
  it("legacy JSONC source file is preserved after successful migration", async () => {
    const legacyContent = '{ "log_level": "DEBUG", "comment": "my config" }';
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": legacyContent,
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    // Source must be byte-for-byte identical after migration
    expect(fs.snapshot()["/project/.opencode/weave-opencode.jsonc"]).toBe(
      legacyContent,
    );
  });

  it("global scope legacy source is preserved after successful migration", async () => {
    const legacyContent = '{ "log_level": "INFO" }';
    const fs = new MemoryFileSystem(
      {
        "/home/user/.config/opencode/weave-opencode.jsonc": legacyContent,
      },
      "/project",
      "/home/user",
    );
    const { ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "global", yes: true },
    });
    await runInit(ctx);
    expect(
      fs.snapshot()["/home/user/.config/opencode/weave-opencode.jsonc"],
    ).toBe(legacyContent);
  });

  it("success output mentions source preserved", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    expect(terminal.out.join("\n")).toContain("Source preserved");
  });
});

// ---------------------------------------------------------------------------
// 2.6 — Provenance comment
// ---------------------------------------------------------------------------

describe("provenance comment", () => {
  it("generated config.weave contains provenance comment header", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
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
    expect(content).toContain("# Migrated from legacy OpenCode JSONC config");
  });

  it("provenance comment names the legacy source file", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
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
    expect(content).toContain("# Source:");
    expect(content).toContain("weave-opencode.jsonc");
  });

  it("provenance comment appears at the top of the file", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
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
    const firstLine = content.split("\n")[0];
    expect(firstLine).toContain("# Migrated from");
  });

  it("provenance comment includes scope information", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
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
    expect(content).toContain("# Scope:");
  });

  it("arbitrary JSONC comments from source are not preserved in output", async () => {
    // The legacy JSONC may contain comments; they must NOT appear in the generated DSL.
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc":
          '// This is a JSONC comment\n{ "log_level": "DEBUG" }',
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
    // The JSONC comment text must not appear in the output
    expect(content).not.toContain("This is a JSONC comment");
  });
});

// ---------------------------------------------------------------------------
// 2.7 — Non-interactive --yes success paths
// ---------------------------------------------------------------------------

describe("non-interactive --yes migrate mode", () => {
  it("weave init migrate --scope local --yes succeeds without prompts", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.err.join("\n")).toBe("");
    expect(fs.snapshot()["/project/.weave/config.weave"]).toBeDefined();
  });

  it("weave init migrate --scope global --yes succeeds without prompts", async () => {
    const fs = new MemoryFileSystem(
      {
        "/home/user/.config/opencode/weave-opencode.jsonc":
          '{ "log_level": "INFO" }',
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "global", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.err.join("\n")).toBe("");
    expect(fs.snapshot()["/home/user/.weave/config.weave"]).toBeDefined();
  });

  it("--yes with existing destination creates backup non-interactively", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
        "/project/.weave/config.weave": "# old config",
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.err.join("\n")).toBe("");
    // Backup created
    expect(fs.snapshot()["/project/.weave/config.weave.bak"]).toBe(
      "# old config",
    );
    // New content written
    expect(fs.snapshot()["/project/.weave/config.weave"]).toContain(
      "Migrated from legacy OpenCode JSONC config",
    );
  });

  it("--yes exits 1 when no legacy source exists", async () => {
    const fs = new MemoryFileSystem({}, "/project", "/home/user");
    const { terminal, ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("No legacy config found");
  });

  it("--yes output contains Migration complete on success", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const { terminal, ctx } = migrateContext({
      fs,
      overrides: { initSubmode: "migrate", scope: "local", yes: true },
    });
    await runInit(ctx);
    expect(terminal.out.join("\n")).toContain("Migration complete");
  });

  it("non-interactive without --yes fails with clear message", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const prompt = new StaticPromptAdapter({ interactive: false });
    const { terminal, ctx } = migrateContext({
      fs,
      prompt,
      overrides: { initSubmode: "migrate", scope: "local" },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain(
      "Interactive mode is unavailable",
    );
    expect(terminal.err.join("\n")).toContain("--yes");
  });
});

// ---------------------------------------------------------------------------
// 2.8 — Interactive preflight behavior (confirm / cancel)
// ---------------------------------------------------------------------------

describe("interactive preflight behavior", () => {
  it("shows Migration preflight header before confirmation prompt", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const prompt = new StaticPromptAdapter({
      confirm: [true, true],
      multiselect: [[]],
    });
    const { terminal, ctx } = migrateContext({
      fs,
      prompt,
      overrides: { initSubmode: "migrate", scope: "local" },
    });
    await runInit(ctx);
    expect(terminal.out.join("\n")).toContain("Migration preflight");
  });

  it("interactive confirm=true proceeds with migration write", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const prompt = new StaticPromptAdapter({
      confirm: [true, true],
      multiselect: [[]],
    });
    const { terminal, ctx } = migrateContext({
      fs,
      prompt,
      overrides: { initSubmode: "migrate", scope: "local" },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(fs.snapshot()["/project/.weave/config.weave"]).toBeDefined();
    expect(terminal.out.join("\n")).toContain("Migration complete");
  });

  it("interactive confirm=false cancels without writing", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
      },
      "/project",
      "/home/user",
    );
    const prompt = new StaticPromptAdapter({ confirm: [false] });
    const { terminal, ctx } = migrateContext({
      fs,
      prompt,
      overrides: { initSubmode: "migrate", scope: "local" },
    });
    const result = await runInit(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("cancelled");
    expect(fs.snapshot()["/project/.weave/config.weave"]).toBeUndefined();
  });

  it("interactive overwrite confirm shows backup intent in prompt message", async () => {
    const fs = new MemoryFileSystem(
      {
        "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" }',
        "/project/.weave/config.weave": "# existing",
      },
      "/project",
      "/home/user",
    );
    // Decline to avoid write — we just want to see the preflight output
    const prompt = new StaticPromptAdapter({ confirm: [false] });
    const { terminal, ctx } = migrateContext({
      fs,
      prompt,
      overrides: { initSubmode: "migrate", scope: "local" },
    });
    await runInit(ctx);
    // Preflight should mention backup
    expect(terminal.out.join("\n")).toContain("backup will be created");
  });
});
