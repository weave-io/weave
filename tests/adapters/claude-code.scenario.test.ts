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
import { bundleFile, frontmatter, generateBundle } from "../support/adapter.js";

const PROJECT_ROOT = "/project";
const OUT_DIR = "/project/.weave/plugins/claude-code";

function build(config: string): Promise<Record<string, string>> {
  return generateBundle(
    config,
    (hooks) =>
      new ClaudeCodeAdapter({
        projectRoot: PROJECT_ROOT,
        homeDir: "/home/user",
        outDir: OUT_DIR,
        ...hooks,
      }),
  );
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
    files = await build(config);
  });

  it("produces a plugin Claude Code can load", () => {
    const manifest = JSON.parse(
      bundleFile(files, `${OUT_DIR}/.claude-plugin/plugin.json`),
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
    expect(bundleFile(files, `${OUT_DIR}/agents/loom.md`)).toContain(
      "You are Loom. You route work to specialists.",
    );
  });

  it("lets the orchestrator delegate, because its policy allows it", () => {
    expect(
      frontmatter(bundleFile(files, `${OUT_DIR}/agents/loom.md`)),
    ).toContain("Task");
  });

  it("withholds delegation from the specialist, because its policy denies it", () => {
    expect(
      frontmatter(bundleFile(files, `${OUT_DIR}/agents/shuttle.md`)),
    ).not.toContain("Task");
  });

  it("makes the orchestrator the agent Claude Code starts in", () => {
    const settings = JSON.parse(bundleFile(files, `${OUT_DIR}/settings.json`));

    expect(settings).toMatchObject({ agent: "loom" });
  });
});

describe("a user adds a category and expects a specialist for it", () => {
  it("ships a generated agent file for the category alongside the declared ones", async () => {
    const files = await build(`
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

    const backend = bundleFile(files, `${OUT_DIR}/agents/shuttle-backend.md`);

    expect(backend).toContain("You are Shuttle.");
    expect(backend).toContain(
      "Guard API contracts and backwards compatibility.",
    );
  });
});
