/**
 * Adapter scenarios — OpenCode (V1).
 *
 * Bucket: Adapters. OpenCode's adapter does not write a plugin bundle; it
 * registers agents with a running harness through a `config` hook. So the black
 * box is the config OpenCode ends up holding: a `.weave` file goes in, and the
 * agents OpenCode now knows about come out.
 *
 * Nothing between those points is asserted — not the translation helpers, not
 * the permission mapper — so any refactor preserving what OpenCode sees leaves
 * these alone.
 */

import { describe, expect, it } from "bun:test";
import { createWeavePlugin } from "../../packages/adapters/opencode/src/plugin.js";
import {
  type RegisteredConfig,
  registeredAgent,
  registeredAgentNames,
  registeredConfig,
  withWeaveProject,
} from "../support/opencode.js";
import { dedent } from "../support/scenario.js";

/** Loads the V1 plugin against a project and returns OpenCode's resulting config. */
function load(config: string): Promise<RegisteredConfig> {
  return withWeaveProject(dedent(config), (root) =>
    registeredConfig(root, async (dir, reader, client) => {
      const plugin = createWeavePlugin({ fileReader: reader });
      return (await plugin({
        client,
        directory: dir,
        project: {} as never,
        worktree: dir,
        experimental_workspace: { register: () => {} },
        serverUrl: new URL("http://localhost:1234"),
        $: {} as never,
      } as never)) as never;
    }),
  );
}

const LOOM_AND_SHUTTLE = `
  agent loom {
    description "Loom (Main Orchestrator)"
    prompt "You are Loom."
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

    tool_policy {
      read allow
      write allow
      execute allow
      delegate deny
    }
  }
`;

describe("a user starts OpenCode in a project with a Weave config", () => {
  it("registers an agent for each one they declared", async () => {
    const cfg = await load(LOOM_AND_SHUTTLE);

    expect(registeredAgentNames(cfg)).toContain("loom");
    expect(registeredAgentNames(cfg)).toContain("shuttle");
  });

  it("gives each agent the prompt the user wrote", async () => {
    const cfg = await load(LOOM_AND_SHUTTLE);

    expect(JSON.stringify(registeredAgent(cfg, "loom"))).toContain(
      "You are Loom.",
    );
  });

  it("marks the agents as Weave-owned, so a later run can tell them apart", async () => {
    const cfg = await load(LOOM_AND_SHUTTLE);

    // Ownership is what lets reconciliation update Weave's agents rather than
    // treating a user's own same-named agent as a collision.
    expect(
      JSON.stringify(registeredAgent(cfg, "loom")).toLowerCase(),
    ).toContain("weave");
  });
});

describe("a user restricts what an agent may do", () => {
  it("carries the restriction into the permissions OpenCode enforces", async () => {
    const cfg = await load(`
      agent auditor {
        prompt "You review code."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent

        tool_policy {
          read allow
          write deny
          execute deny
          delegate deny
        }
      }
    `);

    const permission = registeredAgent(cfg, "auditor").permission as Record<
      string,
      string
    >;

    // OpenCode encodes only restrictions: a denied capability appears as a
    // deny, and an allowed one is simply absent because allow is its default.
    // So `read allow` produces no entry, and asserting one would be wrong.
    expect(permission.edit).toBe("deny");
    expect(permission.bash).toBe("deny");
    expect(Object.values(permission)).not.toContain("allow");
  });
});

describe("a user adds a category", () => {
  it("registers a shuttle for it alongside their declared agents", async () => {
    const cfg = await load(`
      agent shuttle {
        description "Shuttle (Domain Specialist)"
        prompt "You are Shuttle."
        models ["anthropic/claude-sonnet-4-5"]
        mode all
      }

      category backend {
        description "Backend APIs, services, persistence"
        prompt_append "Guard API contracts."
      }
    `);

    expect(registeredAgentNames(cfg)).toContain("shuttle-backend");
    expect(JSON.stringify(registeredAgent(cfg, "shuttle-backend"))).toContain(
      "Guard API contracts.",
    );
  });
});

describe("a user disables an agent", () => {
  it("does not register it", async () => {
    const cfg = await load(`
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

    expect(registeredAgentNames(cfg)).toContain("loom");
    expect(registeredAgentNames(cfg)).not.toContain("shuttle");
  });
});

describe("a user's config does not parse", () => {
  it("leaves OpenCode usable rather than registering a broken agent", async () => {
    const cfg = await load(`
      agent broken {
        prompt "Missing closing brace"
    `);

    // The plugin must not take the harness down over a config typo. It exposes
    // no config hook at all in this case, so OpenCode starts with its own
    // agents and none of Weave's — including the malformed one.
    expect(registeredAgentNames(cfg)).toEqual([]);
  });
});

describe("a user denies each capability in turn", () => {
  it.each([
    ["write", "edit"],
    ["execute", "bash"],
    ["network", "webfetch"],
  ])("denying %s shows up as a deny on the %s permission", async (capability, permissionKey) => {
    // Build the policy without repeating a key: declaring `write allow` and
    // `write deny` in one block is a duplicate the DSL rejects outright, and
    // the agent then never registers at all.
    const policy = ["write", "execute", "network"]
      .map((c) => `          ${c} ${c === capability ? "deny" : "allow"}`)
      .join("\n");

    const cfg = await load(`
        agent restricted {
          prompt "You are restricted."
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent

          tool_policy {
            read allow
${policy}
          }
        }
      `);

    const permission = registeredAgent(cfg, "restricted").permission as Record<
      string,
      string
    >;

    expect(permission[permissionKey]).toBe("deny");
  });

  it("asks rather than denies when the user asks for a prompt", async () => {
    const cfg = await load(`
      agent careful {
        prompt "You are careful."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent

        tool_policy {
          read allow
          write ask
          execute ask
        }
      }
    `);

    const permission = registeredAgent(cfg, "careful").permission as Record<
      string,
      string
    >;

    expect(permission.edit).toBe("ask");
    expect(permission.bash).toBe("ask");
  });
});

describe("a user sets the fields OpenCode reads off an agent", () => {
  it("carries the declared temperature through", async () => {
    const cfg = await load(`
      agent precise {
        prompt "You are precise."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
        temperature 0.42
      }
    `);

    expect(registeredAgent(cfg, "precise").temperature).toBe(0.42);
  });

  it("stops a subagent interrupting the user with a question", async () => {
    const cfg = await load(`
      agent helper {
        prompt "You are a helper."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    // A delegated agent that asks a question stalls the run that delegated to
    // it, so subagents are denied the question permission outright.
    const permission = registeredAgent(cfg, "helper").permission as Record<
      string,
      string
    >;
    expect(permission.question).toBe("deny");
  });

  it("lets a primary agent ask the user a question", async () => {
    const cfg = await load(`
      agent loom {
        prompt "You are Loom."
        models ["anthropic/claude-sonnet-4-5"]
        mode primary
      }
    `);

    const permission = registeredAgent(cfg, "loom").permission as Record<
      string,
      string
    >;
    expect(permission.question).not.toBe("deny");
  });
});

describe("a user denies the capabilities OpenCode encodes outside its permission map", () => {
  it("withholds every reading tool when read is denied", async () => {
    const cfg = await load(`
      agent blindfolded {
        prompt "You are blindfolded."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent

        tool_policy {
          read deny
          write allow
          execute allow
        }
      }
    `);

    // `read` is not a permission in OpenCode; it is the tools map, and denying
    // it has to switch off every tool that reads.
    const tools = registeredAgent(cfg, "blindfolded").tools as Record<
      string,
      boolean
    >;
    for (const tool of ["read", "glob", "grep", "list"]) {
      expect(tools[tool]).toBe(false);
    }
  });

  it("leaves the reading tools alone when read is allowed", async () => {
    const cfg = await load(`
      agent sighted {
        prompt "You are sighted."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent

        tool_policy {
          read allow
          write allow
        }
      }
    `);

    const tools = registeredAgent(cfg, "sighted").tools as
      | Record<string, boolean>
      | undefined;
    expect(tools?.read).not.toBe(false);
  });

  it("denies delegation through the permission OpenCode uses for it", async () => {
    const cfg = await load(`
      agent solo {
        prompt "You are solo."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent

        tool_policy {
          read allow
          delegate deny
        }
      }
    `);

    const permission = registeredAgent(cfg, "solo").permission as Record<
      string,
      string
    >;
    expect(permission.doom_loop).toBe("deny");
  });
});
