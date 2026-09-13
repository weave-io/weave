/**
 * Regression tests for the legacy `@opencode_weave/weave` → Weave upgrade path.
 *
 * Each block pins a problem found by the end-to-end upgrade test:
 *   1. Failed or empty migrations wrote the starter template and reported success.
 *   3. Trailing commas broke migration (published 0.1.2 used JSON.parse).
 *   4. Custom agent descriptions and prompt_file agents were dropped silently.
 * (Problem 2, bare default models, is covered in the OpenCode adapter tests.)
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@weaveio/weave-config";
import { parseConfig } from "@weaveio/weave-core";
import { materializeAgents } from "@weaveio/weave-engine";
import { parse as parseJsonc } from "jsonc-parser";
import { errAsync, okAsync } from "neverthrow";
import { BunFileSystem, MemoryFileSystem } from "../../fs/file-system.js";
import { BufferTerminal } from "../../io/terminal.js";
import {
  convertLegacyJsonc as convertLegacyJsoncResult,
  isLegacyPromptFileReferenceSafe,
  type LegacyConversionOptions,
} from "../../migration/legacy-jsonc-converter.js";
import { readLegacyPromptFiles } from "../../migration/legacy-prompt-files.js";
import { StaticPromptAdapter } from "../../prompt/index.js";
import { ThemeManager } from "../../theme/colors.js";
import { runInit } from "../init.js";
import { checkAgentsMaterialize } from "../validate.js";

const themeManager = new ThemeManager({ isTty: () => false });

const fixtureRoot = new URL(
  "../../__fixtures__/legacy/kitchen-sink/.opencode/",
  import.meta.url,
);
const kitchenSink = await Bun.file(
  new URL("weave-opencode.jsonc", fixtureRoot),
).text();
const reviewerPrompt = await Bun.file(
  new URL("prompts/code-reviewer.md", fixtureRoot),
).text();

/** The same kitchen-sink config with comments and trailing commas removed. */
const kitchenSinkStrict = JSON.stringify(
  parseJsonc(kitchenSink, [], { allowTrailingComma: true }),
  null,
  2,
);

/** `examples/config/github-speckit` from the legacy repo. */
const speckit = `{
  // Weave configuration for the GitHub Spec Kit SDD package
  "$schema": "https://raw.githubusercontent.com/pgermishuys/opencode-weave/v0.7.6/schema/weave-config.schema.json",
  "skill_directories": ["examples/config/github-speckit/skills"]
}`;

/** Fragments that only the starter template would put in a migrated file. */
const STARTER_FRAGMENTS = [
  "Weave starter config",
  "category backend",
  "workflow quick-fix",
  "continuation",
  "analytics",
];

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

async function migrate(
  files: Record<string, string>,
  overrides: Partial<Parameters<typeof runInit>[0]["flags"]> = {
    initSubmode: "migrate",
    scope: "local",
    yes: true,
  },
) {
  const fs = new MemoryFileSystem(files, "/project", "/home/user");
  const terminal = new BufferTerminal();
  const result = await runInit({
    terminal,
    theme: themeManager.getTheme(false),
    flags: flags(overrides),
    fs,
    prompt: new StaticPromptAdapter({ interactive: false }),
  });
  return {
    exitCode: result._unsafeUnwrap(),
    snapshot: fs.snapshot(),
    out: terminal.out.join("\n"),
    err: terminal.err.join("\n"),
  };
}

/** Convert a source that must convert successfully. */
function convertLegacyJsonc(source: string, options?: LegacyConversionOptions) {
  return convertLegacyJsoncResult(source, options)._unsafeUnwrap();
}

function dslLines(content: string): string {
  return content
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Problem 1 — never write the starter template; parse failures write nothing
// ---------------------------------------------------------------------------

describe("legacy upgrade — failed or empty migrations", () => {
  it("a parse failure exits non-zero and writes nothing", async () => {
    const { exitCode, snapshot, out, err } = await migrate({
      "/project/.opencode/weave-opencode.jsonc": '{ "log_level": "DEBUG" ',
    });
    expect(exitCode).toBe(1);
    expect(err).toContain("could not be converted");
    expect(err).toContain("failed to parse legacy JSONC source");
    expect(out).not.toContain("Migration complete");
    expect(snapshot["/project/.weave/config.weave"]).toBeUndefined();
  });

  it("a parse failure leaves an existing destination and backup untouched", async () => {
    const { exitCode, snapshot } = await migrate({
      "/project/.opencode/weave-opencode.jsonc": "{ not json",
      "/project/.weave/config.weave": "# my config\n",
    });
    expect(exitCode).toBe(1);
    expect(snapshot["/project/.weave/config.weave"]).toBe("# my config\n");
    expect(snapshot["/project/.weave/config.weave.bak"]).toBeUndefined();
  });

  it("ordinary init --yes also exits non-zero when the legacy config cannot be converted", async () => {
    const { exitCode, snapshot, err } = await migrate(
      { "/project/.opencode/weave-opencode.jsonc": "{ not json" },
      { scope: "local", yes: true },
    );
    expect(exitCode).toBe(1);
    expect(err).toContain("Migration failed");
    expect(snapshot["/project/.weave/config.weave"]).toBeUndefined();
  });

  it("an everything-skipped config writes only header comments and warnings (speckit)", async () => {
    const { exitCode, snapshot, out } = await migrate({
      "/project/.opencode/weave-opencode.jsonc": speckit,
    });
    expect(exitCode).toBe(0);
    const content = snapshot["/project/.weave/config.weave"] ?? "";
    expect(dslLines(content)).toBe("");
    expect(content).toContain("# Migrated from legacy OpenCode JSONC config");
    expect(content).toContain("#   - skill_directories:");
    expect(content).toContain("# No legacy settings could be converted.");
    for (const fragment of STARTER_FRAGMENTS) {
      expect(content).not.toContain(fragment);
    }
    expect(parseConfig(content).isOk()).toBe(true);
    expect(out).toContain("skill_directories");
  });

  it("ignores $schema silently", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({ $schema: "https://example.com/schema.json" }),
    );
    expect(result.warnings).toEqual([]);
    expect(result.dsl).toBe("");
  });

  it("the delegation-categories example converts with only genuine warnings", () => {
    const result = convertLegacyJsonc(`{
      // Copy this file into your project as .opencode/weave-opencode.jsonc.
      "$schema": "https://raw.githubusercontent.com/pgermishuys/opencode-weave/main/schema/weave-config.schema.json",
      "categories": {
        "backend": {
          "description": "Backend APIs",
          "model": "anthropic/claude-sonnet-4.5",
          "patterns": ["src/api/**"]
        }
      }
    }`);
    expect(result.warnings.map((w) => w.field)).toEqual([
      "categories.backend.patterns",
    ]);
    expect(result.dsl).toContain("category backend {");
  });
});

// ---------------------------------------------------------------------------
// Problem 3 — trailing commas and comments (legacy accepted both)
// ---------------------------------------------------------------------------

describe("legacy upgrade — trailing commas", () => {
  it("converts a realistic config with comments and trailing commas", () => {
    expect(kitchenSink).toMatch(/,\s*[}\]]/);
    const result = convertLegacyJsonc(kitchenSink);
    expect(result.warnings.map((w) => w.field)).not.toContain("<source>");
    expect(result.dsl).toContain("agent loom {");
    expect(result.dsl).toContain("category frontend {");
    expect(parseConfig(result.dsl).isOk()).toBe(true);
  });

  it("produces the same migration with or without trailing commas", () => {
    const promptFileContents = new Map([
      ["prompts/code-reviewer.md", reviewerPrompt.trim()],
    ]);
    expect(convertLegacyJsonc(kitchenSink, { promptFileContents })).toEqual(
      convertLegacyJsonc(kitchenSinkStrict, { promptFileContents }),
    );
  });
});

// ---------------------------------------------------------------------------
// Problem 4 — custom agent descriptions and prompt_file agents
// ---------------------------------------------------------------------------

describe("legacy upgrade — custom agents keep description and prompt", () => {
  it("warns about legacy fields it does not handle instead of dropping them silently", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        agents: { loom: { top_p: 0.9 } },
        custom_agents: { reviewer: { prompt: "Review.", maxTokens: 1000 } },
        categories: { backend: { description: "Backend", variant: "high" } },
      }),
    );
    expect(result.warnings.map((w) => w.field)).toEqual([
      "agents.loom.top_p",
      "custom_agents.reviewer.maxTokens",
      "categories.backend.variant",
    ]);
    // An override whose every field was skipped emits no empty block.
    expect(result.dsl).not.toContain("agent loom");
  });

  it("still reports field-level warnings for a skipped custom agent or category", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: { researcher: { skills: ["research"], top_p: 0.5 } },
        categories: { backend: { variant: "high" } },
      }),
    );
    expect(result.warnings.map((w) => w.field)).toEqual([
      "custom_agents.researcher",
      "custom_agents.researcher.skills",
      "custom_agents.researcher.top_p",
      "categories.backend.description",
      "categories.backend.variant",
    ]);
  });

  it("rejects Windows drive-relative and rooted prompt_file references", () => {
    expect(isLegacyPromptFileReferenceSafe("C:prompts/secret.md")).toBe(false);
    expect(isLegacyPromptFileReferenceSafe("\\prompts\\secret.md")).toBe(false);
    expect(isLegacyPromptFileReferenceSafe("prompts/reviewer.md")).toBe(true);
  });

  it("does not read a prompt_file whose canonical path escapes the config directory", async () => {
    // A symlink inside .opencode/ that points at a file elsewhere.
    class SymlinkFileSystem extends MemoryFileSystem {
      override realPath(path: string) {
        return super
          .realPath(path)
          .map((resolved) =>
            resolved === "/project/.opencode/prompts/evil.md"
              ? "/home/user/.ssh/id_rsa"
              : resolved,
          );
      }
    }
    const fs = new SymlinkFileSystem({
      "/project/.opencode/prompts/evil.md": "linked",
      "/project/.opencode/prompts/ok.md": "Review carefully.",
      "/home/user/.ssh/id_rsa": "PRIVATE KEY",
    });
    const contents = await readLegacyPromptFiles(
      fs,
      "/project/.opencode/weave-opencode.jsonc",
      JSON.stringify({
        custom_agents: {
          evil: { prompt_file: "prompts/evil.md" },
          ok: { prompt_file: "prompts/ok.md" },
        },
      }),
    );
    expect([...contents.entries()]).toEqual([
      ["prompts/ok.md", "Review carefully."],
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "follows real symlinks when checking prompt_file containment",
    async () => {
      const root = join(
        tmpdir(),
        `weave-legacy-symlink-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      await Bun.write(join(root, "secret.txt"), "PRIVATE KEY");
      await Bun.write(join(root, ".opencode", "prompts", "ok.md"), "Review.");
      const link = Bun.spawnSync([
        "ln",
        "-s",
        join(root, "secret.txt"),
        join(root, ".opencode", "prompts", "evil.md"),
      ]);
      expect(link.exitCode).toBe(0);

      const contents = await readLegacyPromptFiles(
        new BunFileSystem(),
        join(root, ".opencode", "weave-opencode.jsonc"),
        JSON.stringify({
          custom_agents: {
            evil: { prompt_file: "prompts/evil.md" },
            ok: { prompt_file: "prompts/ok.md" },
          },
        }),
      );
      expect([...contents.entries()]).toEqual([["prompts/ok.md", "Review."]]);
      Bun.spawnSync(["rm", "-rf", root]);
    },
  );

  it("explains that legacy structured triggers are not migrated", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          reviewer: {
            prompt: "Review.",
            triggers: [{ domain: "Review", trigger: "Reviewing a diff" }],
          },
        },
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.reason).toContain("structured triggers");
  });

  it("weave validate reports agents adapters cannot register", async () => {
    const config = parseConfig(
      [
        "agent orphan {",
        '  description "No prompt at all"',
        "}",
        "agent missing-file {",
        '  prompt_file "nonexistent-weave-dir/missing-file.md"',
        "}",
      ].join("\n"),
    )._unsafeUnwrap();
    const result = await checkAgentsMaterialize("/project", config);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ValidationFailure");
    const messages = error.type === "ValidationFailure" ? error.errors : [];
    expect(messages.some((m) => m.includes('agent "orphan"'))).toBe(true);
    expect(messages.some((m) => m.includes('agent "missing-file"'))).toBe(true);
  });

  it("migrates custom agent descriptions, falling back to display_name", () => {
    const result = convertLegacyJsonc(
      JSON.stringify({
        custom_agents: {
          reviewer: { description: "Reviews diffs", prompt: "Review." },
          helper: { display_name: "Helpful Helper", prompt: "Help." },
        },
      }),
    );
    const config = parseConfig(result.dsl)._unsafeUnwrap();
    expect(config.agents["reviewer"]?.description).toBe("Reviews diffs");
    expect(config.agents["helper"]?.description).toBe("Helpful Helper");
  });

  it("copies a prompt_file resolved relative to .opencode/ into .weave/prompts/", async () => {
    const { exitCode, snapshot, out } = await migrate({
      "/project/.opencode/weave-opencode.jsonc": kitchenSink,
      "/project/.opencode/prompts/code-reviewer.md": reviewerPrompt,
    });
    expect(exitCode).toBe(0);
    expect(snapshot["/project/.weave/prompts/code-reviewer.md"]).toBe(
      reviewerPrompt,
    );
    const content = snapshot["/project/.weave/config.weave"] ?? "";
    expect(content).toContain('prompt_file "code-reviewer.md"');
    expect(content).toContain(
      'description "Reviews diffs for correctness, security, and style"',
    );
    expect(out.replace(/\\/g, "/")).toContain(
      "Prompt:  /project/.weave/prompts/code-reviewer.md",
    );
  });

  it("resolves global prompt_file references relative to ~/.config/opencode/", async () => {
    const { exitCode, snapshot } = await migrate(
      {
        "/home/user/.config/opencode/weave-opencode.jsonc": JSON.stringify({
          custom_agents: { reviewer: { prompt_file: "reviewer.md" } },
        }),
        "/home/user/.config/opencode/reviewer.md": "Global reviewer.\n",
      },
      { initSubmode: "migrate", scope: "global", yes: true },
    );
    expect(exitCode).toBe(0);
    expect(snapshot["/home/user/.weave/prompts/reviewer.md"]).toBe(
      "Global reviewer.\n",
    );
  });

  it("backs up a differing prompt file that is already in .weave/prompts/", async () => {
    const { snapshot } = await migrate({
      "/project/.opencode/weave-opencode.jsonc": kitchenSink,
      "/project/.opencode/prompts/code-reviewer.md": reviewerPrompt,
      "/project/.weave/prompts/code-reviewer.md": "hand-edited\n",
    });
    expect(snapshot["/project/.weave/prompts/code-reviewer.md"]).toBe(
      reviewerPrompt,
    );
    expect(snapshot["/project/.weave/prompts/code-reviewer.md.bak"]).toBe(
      "hand-edited\n",
    );
  });

  it("skips a custom agent whose prompt_file is missing instead of emitting a promptless agent", async () => {
    const { exitCode, snapshot, out } = await migrate({
      "/project/.opencode/weave-opencode.jsonc": kitchenSink,
    });
    expect(exitCode).toBe(0);
    const content = snapshot["/project/.weave/config.weave"] ?? "";
    expect(dslLines(content)).not.toContain("agent code-reviewer");
    expect(out).toContain("custom_agents.code-reviewer: custom agent has no");
  });

  it("every migrated agent materializes with its description and prompt intact", async () => {
    const { snapshot } = await migrate({
      "/project/.opencode/weave-opencode.jsonc": kitchenSink,
      "/project/.opencode/prompts/code-reviewer.md": reviewerPrompt,
    });

    // Load the migrated project exactly as an adapter would, without touching
    // the developer's real ~/.weave.
    const config = (
      await loadConfig("/project", {
        exists: async (path) =>
          snapshot[path.replace(/\\/g, "/")] !== undefined,
        read: (path) => {
          const text = snapshot[path.replace(/\\/g, "/")];
          return text === undefined
            ? errAsync({ type: "FileReadError", path, cause: "missing" })
            : okAsync(text);
        },
      })
    )._unsafeUnwrap();
    const plan = (
      await materializeAgents({
        config,
        promptFileReader: {
          read: (path) => {
            const text = snapshot[path.replace(/\\/g, "/")];
            return text === undefined
              ? errAsync({ message: `missing ${path}` })
              : okAsync(text);
          },
        },
      })
    )._unsafeUnwrap();

    expect(plan.errors).toEqual([]);
    const agents = new Map(
      plan.agents.map(({ agentName, descriptor }) => [agentName, descriptor]),
    );
    for (const name of [
      "loom",
      "tapestry",
      "shuttle",
      "pattern",
      "thread",
      "spindle",
      "weft",
      "code-reviewer",
      "docs-writer",
      "shuttle-backend",
      "shuttle-frontend",
    ]) {
      expect(agents.has(name), `agent ${name}`).toBe(true);
    }
    expect(agents.has("warp")).toBe(false);

    const reviewer = agents.get("code-reviewer");
    expect(reviewer?.description).toBe(
      "Reviews diffs for correctness, security, and style",
    );
    expect(reviewer?.composedPrompt).toContain("# Code Reviewer");
    expect(agents.get("docs-writer")?.description).toBe(
      "Writes and updates project documentation",
    );
    expect(agents.get("loom")?.composedPrompt).toContain(
      "Prefer small, reviewable changes.",
    );
  });
});
