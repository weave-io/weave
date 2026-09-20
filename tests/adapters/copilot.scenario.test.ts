/**
 * Adapter scenarios — GitHub Copilot.
 *
 * Bucket: Adapters. A `.weave` file goes in, the Copilot plugin bundle a user
 * would find on disk comes out. The same promises are checked here as for
 * Claude Code, against a harness with different conventions — which is the
 * point of the bucket: one config, many harnesses, the user's intent preserved
 * in each.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { CopilotAdapter } from "../../packages/adapters/copilot/src/adapter.js";
import { bundleFile, frontmatter, generateBundle } from "../support/adapter.js";

const PROJECT_ROOT = "/project";
const OUT_DIR = "/project/.weave/plugins/copilot";
const AGENTS_DIR = `${OUT_DIR}/com.github.copilot/agents`;

function build(config: string): Promise<Record<string, string>> {
  return generateBundle(
    config,
    (hooks) =>
      new CopilotAdapter({
        projectRoot: PROJECT_ROOT,
        homeDir: "/home/user",
        outDir: OUT_DIR,
        ...hooks,
      }),
  );
}

describe("a user configures an orchestrator and a specialist for Copilot", () => {
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

  it("produces a plugin manifest Copilot can load", () => {
    const manifest = JSON.parse(bundleFile(files, `${OUT_DIR}/plugin.json`));

    expect(manifest).toMatchObject({ name: expect.any(String) });
  });

  it("produces one agent file per declared agent, under Copilot's namespace", () => {
    const agentFiles = Object.keys(files)
      .filter((path) => path.endsWith(".agent.md"))
      .sort();

    expect(agentFiles).toEqual([
      `${AGENTS_DIR}/loom.agent.md`,
      `${AGENTS_DIR}/shuttle.agent.md`,
    ]);
  });

  it("carries the prompt the user wrote into the agent Copilot will run", () => {
    expect(bundleFile(files, `${AGENTS_DIR}/loom.agent.md`)).toContain(
      "You are Loom. You route work to specialists.",
    );
  });

  it("gives every generated agent the frontmatter Copilot requires", () => {
    for (const path of Object.keys(files).filter((p) =>
      p.endsWith(".agent.md"),
    )) {
      expect(frontmatter(bundleFile(files, path))).toContain("name:");
    }
  });
});

describe("a user adds a category and expects a Copilot specialist for it", () => {
  it("ships a generated agent file carrying the category's own guidance", async () => {
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

    const backend = bundleFile(files, `${AGENTS_DIR}/shuttle-backend.agent.md`);

    expect(backend).toContain("You are Shuttle.");
    expect(backend).toContain(
      "Guard API contracts and backwards compatibility.",
    );
  });
});

describe("a user disables an agent", () => {
  it("leaves no file behind for it in the Copilot bundle", async () => {
    const files = await build(`
      agent loom {
        prompt "You are Loom."
        models ["anthropic/claude-sonnet-4-5"]
        mode primary
      }

      agent shuttle {
        prompt "You are Shuttle."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }

      disable agents ["shuttle"]
    `);

    const agentFiles = Object.keys(files).filter((p) =>
      p.endsWith(".agent.md"),
    );

    expect(agentFiles).toEqual([`${AGENTS_DIR}/loom.agent.md`]);
  });
});
