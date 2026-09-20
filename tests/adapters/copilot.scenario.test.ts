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
import {
  bundleFile,
  type ExistingBundle,
  frontmatter,
  generateBundle,
  type MemoryIO,
  runAdapter,
} from "../support/adapter.js";

const PROJECT_ROOT = "/project";
const OUT_DIR = "/project/.weave/plugins/copilot";
const AGENTS_DIR = `${OUT_DIR}/com.github.copilot/agents`;

function adapterFor(hooks: MemoryIO["hooks"]) {
  return new CopilotAdapter({
    projectRoot: PROJECT_ROOT,
    homeDir: "/home/user",
    outDir: OUT_DIR,
    ...hooks,
  });
}

function build(config: string): Promise<Record<string, string>> {
  return generateBundle(config, adapterFor);
}

function regenerate(config: string, options: ExistingBundle) {
  return runAdapter(config, adapterFor, options);
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

describe("a user writes only the minimum for an agent", () => {
  it("omits the description rather than inventing one", async () => {
    const files = await build(`
      agent bare {
        prompt "You are bare."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    const fm = frontmatter(bundleFile(files, `${AGENTS_DIR}/bare.agent.md`));

    expect(fm).toContain("name:");
    expect(fm).not.toContain("description:");
  });
});

describe("a user grants an agent every capability", () => {
  it("gives it a Copilot tool for each one", async () => {
    const files = await build(agentWithPolicy("everything", ALL_ALLOWED));
    const fm = frontmatter(
      bundleFile(files, `${AGENTS_DIR}/everything.agent.md`),
    );

    // Copilot names several concrete tools per capability; one representative
    // of each is enough to prove the capability reached the file.
    for (const tool of ["read", "edit", "execute"]) {
      expect(fm).toContain(tool);
    }
  });
});

describe("a user denies an agent a capability", () => {
  it.each([
    ["execute", ["execute", "shell", "Bash", "powershell"]],
    ["write", ["edit", "Edit", "MultiEdit", "Write"]],
  ])("denying %s withholds every tool that exercises it", async (capability, tools) => {
    const policy = ALL_ALLOWED.replace(
      `${capability} allow`,
      `${capability} deny`,
    );
    const files = await build(agentWithPolicy("restricted", policy));
    const fm = frontmatter(
      bundleFile(files, `${AGENTS_DIR}/restricted.agent.md`),
    );

    for (const tool of tools) {
      expect(fm).not.toContain(`- ${tool}\n`);
    }
    // Denial is scoped: what was not denied survives.
    expect(fm).toContain("read");
  });
});

describe("a user's orchestrator can delegate to Weave specialists", () => {
  const config = `
    agent loom {
      description "Loom (Main Orchestrator)"
      prompt "You are Loom. Delegate implementation work to shuttle."
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
      prompt "You are Shuttle."
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent
      triggers ["Use for implementation work"]
    }
  `;

  /** The prompt body, below the frontmatter. */
  const body = (markdown: string) => markdown.split(/^---$/m).slice(2).join("");

  it("qualifies references in the prompt so Copilot routes to the Weave agent, not its own built-in", async () => {
    const files = await build(config);
    const loom = body(bundleFile(files, `${AGENTS_DIR}/loom.agent.md`));

    // An unqualified "shuttle" in the prose would let Copilot pick a built-in
    // of that name instead of the Weave agent.
    expect(loom).toContain("weave:shuttle");
  });

  it("leaves the prompt of an agent that cannot delegate untouched", async () => {
    const files = await build(config);
    const shuttle = body(bundleFile(files, `${AGENTS_DIR}/shuttle.agent.md`));

    // Frontmatter `name:` is qualified for every agent — that is the plugin id,
    // not delegation adaptation, so the body is what matters here.
    expect(shuttle).not.toContain("weave:");
  });
});

describe("a user regenerates after removing an agent", () => {
  it("deletes the agent file the previous run left behind", async () => {
    const { removed } = await regenerate(SHUTTLE_ONLY, {
      existing: { agents: ["shuttle.agent.md", "retired.agent.md"] },
    });

    expect(removed.some((p) => p.endsWith("retired.agent.md"))).toBe(true);
    expect(removed.some((p) => p.endsWith("shuttle.agent.md"))).toBe(false);
  });
});
