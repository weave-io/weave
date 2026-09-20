/**
 * Adapter scenarios — Claude Code.
 *
 * Bucket: Adapters. The black box spans the whole product: a `.weave` file goes
 * in at one end, and the plugin bundle a user would find on disk comes out at
 * the other. Nothing between those two points is asserted — no descriptor
 * literals, no translation helpers, no lookup tables — so any internal refactor
 * that preserves the generated bundle leaves these tests alone.
 *
 * These replace the adapter's white-box tests for the same promises. What still
 * lives beside the source is what a user cannot observe from here: skill
 * discovery (a filesystem scanner), the adapter↔engine model-resolution
 * contract, and the integrity of the shipped bootstrap plugin.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { ClaudeCodeAdapter } from "../../packages/adapters/claude-code/src/adapter.js";
import {
  bundleFile,
  type ExistingBundle,
  frontmatter,
  generateBundle,
  type MemoryIO,
  memoryIO,
  runAdapter,
} from "../support/adapter.js";
import { whenMaterialized } from "../support/scenario.js";

const PROJECT_ROOT = "/project";
const OUT_DIR = "/project/.weave/plugins/claude-code";
const AGENTS = `${OUT_DIR}/agents`;

function adapterFor(hooks: MemoryIO["hooks"], outDir = OUT_DIR) {
  return new ClaudeCodeAdapter({
    projectRoot: PROJECT_ROOT,
    homeDir: "/home/user",
    outDir,
    ...hooks,
  });
}

function build(config: string): Promise<Record<string, string>> {
  return generateBundle(config, (hooks) => adapterFor(hooks));
}

function regenerate(config: string, options: ExistingBundle) {
  return runAdapter(config, (hooks) => adapterFor(hooks), options);
}

/** An agent declaration carrying the given tool policy lines. */
function agentWithPolicy(name: string, policy: string): string {
  return `
    agent ${name} {
      description "${name} agent"
      prompt "You are ${name}."
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent

      tool_policy {
        ${policy}
      }
    }
  `;
}

const ALL_ALLOWED = `
  read allow
  write allow
  execute allow
  delegate allow
  network allow
`;

const SHUTTLE_ONLY = `
  agent shuttle {
    prompt "You are Shuttle."
    models ["anthropic/claude-sonnet-4-5"]
    mode subagent
  }
`;

describe("a user generates a Claude Code plugin from their config", () => {
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

  it("produces a plugin manifest Claude Code can load", () => {
    const manifest = JSON.parse(
      bundleFile(files, `${OUT_DIR}/.claude-plugin/plugin.json`),
    );

    expect(manifest).toMatchObject({ name: expect.any(String) });
  });

  it("produces one agent file per declared agent, and no others", () => {
    // `startsWith(AGENTS)` would also match a sibling such as `agents-old/`,
    // letting a stray file slip past the "and no others" claim.
    const agentFiles = Object.keys(files)
      .filter((path) => path.startsWith(`${AGENTS}/`) && path.endsWith(".md"))
      .sort();

    expect(agentFiles).toEqual([`${AGENTS}/loom.md`, `${AGENTS}/shuttle.md`]);
  });

  it("carries the prompt the user wrote into the agent Claude Code will run", () => {
    expect(bundleFile(files, `${AGENTS}/loom.md`)).toContain(
      "You are Loom. You route work to specialists.",
    );
  });

  it("names each agent in its frontmatter", () => {
    expect(frontmatter(bundleFile(files, `${AGENTS}/shuttle.md`))).toContain(
      "name: shuttle",
    );
  });

  it("carries the declared description", () => {
    expect(frontmatter(bundleFile(files, `${AGENTS}/loom.md`))).toContain(
      "Loom (Main Orchestrator)",
    );
  });

  it("translates the declared model to the alias Claude Code expects", () => {
    // The user writes `anthropic/claude-sonnet-4-5`; Claude Code wants its own
    // short alias, and the adapter is what bridges the two.
    expect(frontmatter(bundleFile(files, `${AGENTS}/loom.md`))).toContain(
      "model: sonnet",
    );
  });
});

describe("a user writes only the minimum for an agent", () => {
  it("omits the description rather than inventing one", async () => {
    const files = await build(`
      agent bare {
        prompt "You are bare."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    const fm = frontmatter(bundleFile(files, `${AGENTS}/bare.md`));

    expect(fm).toContain("name: bare");
    expect(fm).not.toContain("description:");
  });
});

describe("a user names a model Claude Code does not recognise", () => {
  it("falls back to one it does, rather than emitting a model the harness would reject", async () => {
    const files = await build(`
      agent experimental {
        prompt "You are experimental."
        models ["some-vendor/unreleased-model-x"]
        mode subagent
      }
    `);

    const fm = frontmatter(bundleFile(files, `${AGENTS}/experimental.md`));

    // An agent's `models` list is filtered against what the adapter knows this
    // harness can run; nothing survives here, so resolution reaches its
    // constant fallback. Worth knowing: the unrecognised name is dropped
    // silently, so a typo in `models` yields a working agent on the wrong model
    // rather than an error.
    expect(fm).toContain("model: sonnet");
    expect(fm).not.toContain("some-vendor/unreleased-model-x");
  });
});

describe("a user grants an agent every capability", () => {
  it("gives it the Claude Code tool for each one", async () => {
    const files = await build(agentWithPolicy("everything", ALL_ALLOWED));
    const fm = frontmatter(bundleFile(files, `${AGENTS}/everything.md`));

    for (const tool of [
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Bash",
      "Task",
      "Agent",
      "WebFetch",
      "WebSearch",
    ]) {
      expect(fm).toContain(tool);
    }
  });
});

describe("a user denies an agent a capability", () => {
  it.each([
    ["execute", ["Bash"]],
    ["write", ["Write", "Edit", "MultiEdit"]],
    ["delegate", ["Task", "Agent"]],
    ["network", ["WebFetch", "WebSearch"]],
  ])("denying %s withholds the tools that exercise it", async (capability, tools) => {
    const policy = ALL_ALLOWED.replace(
      `${capability} allow`,
      `${capability} deny`,
    );
    const files = await build(agentWithPolicy("restricted", policy));
    const fm = frontmatter(bundleFile(files, `${AGENTS}/restricted.md`));

    for (const tool of tools) {
      expect(fm).not.toContain(tool);
    }
    // Denial is scoped: the agent keeps everything it was not denied.
    expect(fm).toContain("Read");
  });

  it("omits the tools section entirely when nothing is left", async () => {
    const files = await build(
      agentWithPolicy(
        "powerless",
        `
        read deny
        write deny
        execute deny
        delegate deny
        network deny
      `,
      ),
    );

    expect(
      frontmatter(bundleFile(files, `${AGENTS}/powerless.md`)),
    ).not.toContain("tools:");
  });
});

describe("a user declares a primary orchestrator", () => {
  it("makes it the agent Claude Code starts in", async () => {
    const files = await build(`
      agent loom {
        prompt "You are Loom."
        models ["anthropic/claude-sonnet-4-5"]
        mode primary
      }
    `);

    expect(
      JSON.parse(bundleFile(files, `${OUT_DIR}/settings.json`)),
    ).toMatchObject({ agent: "loom" });
  });
});

describe("a user's config has no orchestrator", () => {
  let files: Record<string, string>;

  beforeAll(async () => {
    files = await build(SHUTTLE_ONLY);
  });

  it("writes no settings.json rather than choosing a starting agent for them", () => {
    expect(files[`${OUT_DIR}/settings.json`]).toBeUndefined();
  });

  it("still produces the plugin and its agent files", () => {
    expect(files[`${OUT_DIR}/.claude-plugin/plugin.json`]).toBeDefined();
    expect(files[`${AGENTS}/shuttle.md`]).toBeDefined();
  });
});

describe("a user adds a category", () => {
  it("ships a specialist agent carrying the category's own guidance", async () => {
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

    const backend = bundleFile(files, `${AGENTS}/shuttle-backend.md`);

    expect(backend).toContain("You are Shuttle.");
    expect(backend).toContain(
      "Guard API contracts and backwards compatibility.",
    );
    expect(frontmatter(backend)).toContain("name: shuttle-backend");
  });
});

describe("a user declares the tapestry orchestrator", () => {
  it("ships the workflow commands that drive it, forked from the main session", async () => {
    const files = await build(`
      agent tapestry {
        prompt "You are Tapestry."
        models ["anthropic/claude-sonnet-4-5"]
        mode primary
      }
    `);

    const commands = Object.keys(files).filter((p) => p.includes("/commands/"));
    expect(commands.length).toBeGreaterThan(0);

    for (const path of commands) {
      expect(files[path]).toContain("context: fork");
      expect(files[path]).toContain("agent: weave:tapestry");
    }
  });
});

describe("a user's config has no tapestry", () => {
  it("ships no workflow commands", async () => {
    const files = await build(SHUTTLE_ONLY);

    expect(Object.keys(files).filter((p) => p.includes("/commands/"))).toEqual(
      [],
    );
  });
});

describe("a user removes an agent and regenerates", () => {
  it("deletes the agent file the previous run left behind", async () => {
    const { removed } = await regenerate(SHUTTLE_ONLY, {
      existing: { agents: ["shuttle.md", "retired-agent.md"] },
    });

    expect(removed).toContain(`${AGENTS}/retired-agent.md`);
    expect(removed).not.toContain(`${AGENTS}/shuttle.md`);
  });

  it("leaves files it does not own alone", async () => {
    const { removed } = await regenerate(SHUTTLE_ONLY, {
      existing: { agents: ["shuttle.md", "notes.txt"] },
    });

    expect(removed).not.toContain(`${AGENTS}/notes.txt`);
  });
});

describe("a user removes tapestry and regenerates", () => {
  it("deletes the workflow commands that no longer apply", async () => {
    const { removed } = await regenerate(SHUTTLE_ONLY, {
      existing: { commands: ["start.md", "start-work.md"] },
    });

    expect(removed.some((p) => p.endsWith("start.md"))).toBe(true);
    expect(removed.some((p) => p.endsWith("start-work.md"))).toBe(true);
  });
});

describe("a user points the plugin at their own directory", () => {
  it("writes the bundle there instead of the default location", async () => {
    const custom = "/project/custom-plugin-dir";
    const written = await generateBundle(SHUTTLE_ONLY, (hooks) =>
      adapterFor(hooks, custom),
    );

    expect(Object.keys(written).length).toBeGreaterThan(0);
    for (const path of Object.keys(written)) {
      expect(path.startsWith(custom)).toBe(true);
    }
  });
});

describe("a user's agents are queued but not yet flushed", () => {
  it("writes nothing to disk until the bundle is flushed", async () => {
    const { written, hooks } = memoryIO();
    const adapter = adapterFor(hooks);
    await adapter.init();

    const plan = await whenMaterialized(SHUTTLE_ONLY);
    for (const entry of plan.agents) {
      await adapter.spawnSubagent(entry.descriptor);
    }

    expect(Object.keys(written)).toEqual([]);

    await adapter.flush();
    expect(Object.keys(written).length).toBeGreaterThan(0);
  });
});
