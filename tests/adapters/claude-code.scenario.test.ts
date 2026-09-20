/**
 * Adapter scenarios — Claude Code.
 *
 * Bucket: Adapters. The black box spans the whole product: a `.weave` file goes
 * in at one end, and the harness configuration a user would actually find on
 * disk comes out at the other. Nothing between those two points is asserted
 * directly — no descriptor literals, no translation helpers — so the test keeps
 * passing through any internal refactor that preserves the user-visible result.
 *
 * The adapter's injectable I/O captures writes in memory, so no real plugin
 * bundle is created.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { ClaudeCodeAdapter } from "../../packages/adapters/claude-code/src/adapter.js";
import { whenMaterialized } from "../support/scenario.js";

const PROJECT_ROOT = "/project";
const OUT_DIR = "/project/.weave/plugins/claude-code";

/**
 * Runs the pipeline a user triggers with `weave init --harness claude-code`:
 * parse the config, resolve every agent, hand them to the adapter, flush.
 * Returns the files the user would find in the generated plugin bundle.
 */
async function generatePluginBundle(
  config: string,
): Promise<Record<string, string>> {
  const written: Record<string, string> = {};
  const adapter = new ClaudeCodeAdapter({
    projectRoot: PROJECT_ROOT,
    homeDir: "/home/user",
    outDir: OUT_DIR,
    exists: async () => true,
    readDir: async () => [],
    readFile: async () => "",
    mkdir: async () => {},
    writeFile: async (path, content) => {
      written[path] = content;
    },
  });

  await adapter.init();

  const plan = await whenMaterialized(config);
  for (const entry of plan.agents) {
    const result = await adapter.spawnSubagent(entry.descriptor);
    expect(result.isOk()).toBe(true);
  }

  const flushed = await adapter.flush();
  expect(flushed.isOk()).toBe(true);

  return written;
}

/** Reads one generated file by its path inside the bundle. */
function bundleFile(
  files: Record<string, string>,
  relativePath: string,
): string {
  const full = `${OUT_DIR}/${relativePath}`;
  const content = files[full];
  if (content === undefined) {
    expect(Object.keys(files).sort()).toContain(full);
    throw new Error("unreachable");
  }
  return content;
}

/** The YAML frontmatter block at the top of a generated agent file. */
function frontmatter(markdown: string): string {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("a user configures an orchestrator and a specialist for Claude Code", () => {
  const config = `
    agent loom {
      description "Loom (Main Orchestrator)"
      prompt "You are Loom. You route work to specialists."
      models ["anthropic/claude-sonnet-4-5"]
      mode primary

      tool_policy {
        read allow
        write allow
        execute allow
        delegate allow
      }
    }

    agent shuttle {
      description "Shuttle (Domain Specialist)"
      prompt "You are Shuttle. You do the work you are given."
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent

      tool_policy {
        read allow
        write allow
        execute allow
        delegate deny
      }
    }
  `;

  let files: Record<string, string>;

  beforeAll(async () => {
    files = await generatePluginBundle(config);
  });

  it("produces a plugin Claude Code can load", () => {
    const manifest = JSON.parse(
      bundleFile(files, ".claude-plugin/plugin.json"),
    );

    expect(manifest).toMatchObject({ name: expect.any(String) });
  });

  it("produces one agent file per agent the user declared", () => {
    const agentFiles = Object.keys(files)
      .filter((path) => path.includes("/agents/"))
      .sort();

    expect(agentFiles).toEqual([
      `${OUT_DIR}/agents/loom.md`,
      `${OUT_DIR}/agents/shuttle.md`,
    ]);
  });

  it("carries the prompt the user wrote into the agent Claude Code will run", () => {
    expect(bundleFile(files, "agents/loom.md")).toContain(
      "You are Loom. You route work to specialists.",
    );
  });

  it("lets the orchestrator delegate, because its policy allows it", () => {
    expect(frontmatter(bundleFile(files, "agents/loom.md"))).toContain("Task");
  });

  it("withholds delegation from the specialist, because its policy denies it", () => {
    expect(frontmatter(bundleFile(files, "agents/shuttle.md"))).not.toContain(
      "Task",
    );
  });

  it("makes the orchestrator the agent Claude Code starts in", () => {
    const settings = JSON.parse(bundleFile(files, "settings.json"));

    expect(settings).toMatchObject({ agent: "loom" });
  });
});

describe("a user adds a category and expects a specialist for it", () => {
  it("ships a generated agent file for the category alongside the declared ones", async () => {
    const files = await generatePluginBundle(`
      agent shuttle {
        description "Shuttle (Domain Specialist)"
        prompt "You are Shuttle."
        models ["anthropic/claude-sonnet-4-5"]
        mode all
      }

      category backend {
        description "Backend APIs, services, persistence"
        models ["anthropic/claude-opus-4-1"]
        prompt_append "Guard API contracts and backwards compatibility."
      }
    `);

    const backend = bundleFile(files, "agents/shuttle-backend.md");

    expect(backend).toContain("You are Shuttle.");
    expect(backend).toContain(
      "Guard API contracts and backwards compatibility.",
    );
  });
});
