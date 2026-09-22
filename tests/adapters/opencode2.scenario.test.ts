/**
 * Adapter scenarios — OpenCode 2.
 *
 * Bucket: Adapters. The V2 adapter writes no files. Its plugin is handed a
 * live host and reconciles Weave's agents, its slash command, its session
 * hooks and its plan RPC into that host. So the black box is **the running
 * host the plugin leaves behind**: a `.weave` file and a host inventory go in,
 * and the agents `opencode2 debug agents` would list, what each may do, the
 * command a user can type and what that command does to their session come
 * out.
 *
 * Nothing in between is asserted — not the catalog builder, not the
 * permission mapper, not the projection — so a refactor that preserves what
 * the host sees leaves these alone.
 *
 * The entry seam is `setupOpenCode2(context)`, which is exactly the callback
 * `Plugin.define({ id: "weave", setup })` registers and the only entry point
 * `@weaveio/weave-adapter-opencode2/server` publishes. See
 * [`tests/support/opencode2.ts`](../support/opencode2.ts) for the host double.
 */

import { describe, expect, it } from "bun:test";
import {
  HOST_DEFAULT_PERMISSIONS,
  type HostOptions,
  isRpcFailure,
  loadWeaveOnOpenCode2,
  type OpenCode2Host,
  withWeaveOnOpenCode2,
} from "../support/opencode2.js";
import { dedent } from "../support/scenario.js";

/** A host whose catalog offers the model Weave's builtin agents ask for. */
const ANTHROPIC_HOST: HostOptions = {
  models: [
    {
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
      variants: ["thinking"],
    },
  ],
};

/** Every agent Weave ships out of the box. */
const BUILTIN_AGENTS = [
  "loom",
  "pattern",
  "shuttle",
  "spindle",
  "tapestry",
  "thread",
  "warp",
  "weft",
];

const PLAN_FILE =
  "# Release\n\n- [ ] Build it\n  - [ ] Compile\n- [ ] Ship it\n";

interface ScenarioInput {
  readonly config?: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly host?: HostOptions;
}

function load(input: ScenarioInput = {}): Promise<OpenCode2Host> {
  return loadWeaveOnOpenCode2({
    ...input,
    ...(input.config === undefined ? {} : { config: dedent(input.config) }),
  });
}

function live<T>(
  input: ScenarioInput,
  body: (host: OpenCode2Host) => Promise<T>,
): Promise<T> {
  return withWeaveOnOpenCode2(
    {
      ...input,
      ...(input.config === undefined ? {} : { config: dedent(input.config) }),
    },
    body,
  );
}

interface StatusReport {
  readonly agentCount: number;
  readonly refresh: string;
  readonly issues: ReadonlyArray<{
    code: string;
    agentName?: string;
    count?: number;
  }>;
  readonly readiness: Record<string, boolean>;
}

/**
 * The `status` RPC payload, which is what the plan panel shows a user.
 *
 * It is read while the plugin is still active: a deactivated plugin reports
 * `disposed`, which would make every assertion here vacuously about teardown.
 */
function statusOf(input: ScenarioInput): Promise<StatusReport> {
  return live(
    input,
    async (host) => (await host.rpc("status")) as StatusReport,
  );
}

// ---------------------------------------------------------------------------

describe("a user installs Weave on an OpenCode 2 host that can run the models it asks for", () => {
  it("gives the host every agent Weave ships, so they can be selected by name", async () => {
    const host = await load({ host: ANTHROPIC_HOST });

    expect(host.agentNames()).toEqual(BUILTIN_AGENTS);
  });

  it("marks each one as Weave-managed, so a later run can tell them from the host's own", async () => {
    const host = await load({ host: ANTHROPIC_HOST });

    for (const name of BUILTIN_AGENTS) {
      expect(host.agent(name).description).toStartWith("[weave-managed]");
    }
  });

  it("puts the orchestrator in front of the user and the specialists behind it", async () => {
    const host = await load({ host: ANTHROPIC_HOST });

    expect(host.agent("loom").mode).toBe("primary");
    expect(host.agent("shuttle").mode).toBe("subagent");
  });

  it("points every agent at the configured model on the provider that offers it", async () => {
    const host = await load({ host: ANTHROPIC_HOST });

    expect(host.agent("loom").model).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
    });
  });

  it("offers the plan command, because Tapestry is one of the agents it owns", async () => {
    const host = await load({ host: ANTHROPIC_HOST });

    expect(host.commandNames()).toEqual(["weave:start"]);
  });

  it("reports itself ready, with no issues for the user to fix", async () => {
    const report = await statusOf({ host: ANTHROPIC_HOST });

    expect(report.issues).toEqual([]);
    expect(report.agentCount).toBe(BUILTIN_AGENTS.length);
    expect(report.readiness).toMatchObject({
      nativeAgents: true,
      requestIntent: true,
      foregroundPlans: true,
      nativeDelegation: true,
      durableWorkflows: false,
    });
  });
});

describe("a user's host has none of the models their agents ask for", () => {
  const NO_ANTHROPIC: HostOptions = {
    models: [{ providerID: "probe", id: "fast" }],
  };

  it("still registers every agent, leaving the model to the host", async () => {
    const host = await load({ host: NO_ANTHROPIC });

    expect(host.agentNames()).toEqual(BUILTIN_AGENTS);
  });

  it("registers them without a model, so the host applies its own selection", async () => {
    const host = await load({ host: NO_ANTHROPIC });

    for (const name of BUILTIN_AGENTS) {
      expect(host.agent(name).model).toBeUndefined();
    }
  });

  it("names every agent whose model did not resolve, so the substitution is visible", async () => {
    const report = await statusOf({ host: NO_ANTHROPIC });

    expect(report.issues.map((issue) => issue.code)).toEqual(
      BUILTIN_AGENTS.map(() => "model_unavailable"),
    );
    expect(report.issues.map((issue) => issue.agentName).sort()).toEqual(
      BUILTIN_AGENTS,
    );
  });

  it("keeps the plan command, because Tapestry survived to run it", async () => {
    const host = await load({ host: NO_ANTHROPIC });

    expect(host.commandNames()).toEqual(["weave:start"]);
  });
});

describe("a user names a model without saying which provider should serve it", () => {
  const CONFIG = `
    agent scribe {
      description "Writes things down"
      prompt "You are the scribe."
      models ["house-model"]
      mode subagent
    }
  `;

  it("uses the only provider that offers it when there is exactly one", async () => {
    const host = await load({
      config: CONFIG,
      host: { models: [{ providerID: "acme", id: "house-model" }] },
    });

    expect(host.agent("scribe").model).toEqual({
      providerID: "acme",
      id: "house-model",
    });
  });

  it("refuses to guess when two providers offer it, and leaves the model to the host", async () => {
    const input = {
      config: CONFIG,
      host: {
        models: [
          { providerID: "acme", id: "house-model" },
          { providerID: "other", id: "house-model" },
        ],
      },
    };

    expect((await load(input)).agent("scribe").model).toBeUndefined();
    expect((await statusOf(input)).issues).toContainEqual({
      code: "model_unavailable",
      agentName: "scribe",
    });
  });
});

describe("a user asks for a model variant", () => {
  it("selects the variant when the host's model offers it", async () => {
    const host = await load({
      config: `
        agent scribe {
          prompt "You are the scribe."
          models ["anthropic/claude-sonnet-4-5#thinking"]
          mode subagent
        }
      `,
      host: ANTHROPIC_HOST,
    });

    expect(host.agent("scribe").model).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
      variant: "thinking",
    } as never);
  });

  it("will not fall back to the base model when the variant is unknown, and leaves the model to the host", async () => {
    const input = {
      config: `
        agent scribe {
          prompt "You are the scribe."
          models ["anthropic/claude-sonnet-4-5#turbo"]
          mode subagent
        }
      `,
      host: ANTHROPIC_HOST,
    };

    // Not the requested variant, and not the base model either — an
    // unresolvable variant hands model choice back to OpenCode rather than
    // quietly downgrading to the same model without its variant.
    expect((await load(input)).agent("scribe").model).toBeUndefined();
    expect((await statusOf(input)).issues).toContainEqual({
      code: "model_unavailable",
      agentName: "scribe",
    });
  });
});

describe("a user lists several models in preference order", () => {
  it("falls through to the next one when the one before it cannot be resolved", async () => {
    const host = await load({
      config: `
        agent scribe {
          prompt "You are the scribe."
          models ["house-model", "acme/other-model"]
          mode subagent
        }
      `,
      host: {
        models: [
          // "house-model" is ambiguous, so the second entry has to carry it.
          { providerID: "acme", id: "house-model" },
          { providerID: "other", id: "house-model" },
          { providerID: "acme", id: "other-model" },
        ],
      },
    });

    expect(host.agent("scribe").model).toEqual({
      providerID: "acme",
      id: "other-model",
    });
  });
});

describe("a user declares no model for an agent", () => {
  it("leaves the agent on whatever model the session is using", async () => {
    const host = await load({
      config: `
        agent scribe {
          prompt "You are the scribe."
          mode subagent
        }
      `,
    });

    expect(host.agent("scribe").model).toBeUndefined();
  });
});

describe("a user writes a tool_policy for an agent", () => {
  const CONFIG = `
    agent scribe {
      description "Writes things down"
      prompt "You are the scribe."
      models ["probe/fast"]
      mode subagent

      tool_policy {
        read allow
        write deny
        execute ask
        delegate deny
        network ask
      }
    }
  `;

  it.each([
    ["reading", ["read", "glob", "grep"], "allow"],
    ["writing", ["edit"], "deny"],
    ["running commands", ["shell"], "ask"],
    ["reaching the network", ["webfetch", "websearch"], "ask"],
  ])("gives the host a rule for %s that matches what they asked for", async (_dimension, actions, effect) => {
    const host = await load({ config: CONFIG });

    expect(host.effectsFor("scribe", actions)).toEqual(
      actions.map(() => effect),
    );
  });

  it("denies delegation outright when they asked for it to be denied", async () => {
    const host = await load({ config: CONFIG });

    expect(
      host
        .agent("scribe")
        .permissions.filter((rule) => rule.action === "subagent"),
    ).toEqual([{ action: "subagent", resource: "*", effect: "deny" }]);
  });

  it("stops the specialist interrupting the user with a question it cannot answer", async () => {
    const host = await load({ config: CONFIG });

    expect(host.effectFor("scribe", "question")).toBe("deny");
  });

  it("leaves the host's own safeguards for actions Weave does not manage", async () => {
    const host = await load({ config: CONFIG });

    expect(host.effectFor("scribe", "todo")).toBe(
      HOST_DEFAULT_PERMISSIONS.find((rule) => rule.action === "todo")?.effect,
    );
  });
});

describe("a user declares an agent without a tool_policy", () => {
  it("asks before every action Weave manages, rather than assuming consent", async () => {
    const host = await load({
      config: `
        agent scribe {
          prompt "You are the scribe."
          models ["probe/fast"]
          mode subagent
        }
      `,
    });

    expect(
      host.effectsFor("scribe", [
        "read",
        "glob",
        "grep",
        "edit",
        "shell",
        "webfetch",
        "websearch",
      ]),
    ).toEqual(["ask", "ask", "ask", "ask", "ask", "ask", "ask"]);
  });
});

describe("a user has an agent that may delegate", () => {
  it("names each specialist it may reach and denies everything else", async () => {
    const host = await load({ host: ANTHROPIC_HOST });
    const rules = host
      .agent("loom")
      .permissions.filter((rule) => rule.action === "subagent");

    expect(rules[0]).toEqual({
      action: "subagent",
      resource: "*",
      effect: "deny",
    });
    expect(rules.slice(1).map((rule) => rule.resource)).toEqual([
      "shuttle",
      "pattern",
      "thread",
      "spindle",
      "weft",
      "warp",
    ]);
  });

  it("tells the orchestrator how to reach those specialists in its own prompt", async () => {
    const host = await load({ host: ANTHROPIC_HOST });

    expect(String(host.agent("loom").system)).toContain(
      "native subagent tool for these specialists",
    );
  });

  it("lets a user-facing agent ask the user a question, unlike a specialist", async () => {
    const host = await load({ host: ANTHROPIC_HOST });

    expect(host.effectFor("loom", "question")).toBe("allow");
    expect(host.effectFor("shuttle", "question")).toBe("deny");
  });
});

describe("a user turns some agents off", () => {
  const CONFIG = `
    disable agents ["warp", "spindle"]
  `;

  it("leaves them out of the host entirely", async () => {
    const host = await load({ config: CONFIG, host: ANTHROPIC_HOST });

    expect(host.agentNames()).not.toContain("warp");
    expect(host.agentNames()).not.toContain("spindle");
  });

  it("stops the orchestrator being allowed to delegate to them, so no route dangles", async () => {
    const host = await load({ config: CONFIG, host: ANTHROPIC_HOST });
    const targets = host
      .agent("loom")
      .permissions.filter(
        (rule) => rule.action === "subagent" && rule.resource !== "*",
      )
      .map((rule) => rule.resource);

    expect(targets).not.toContain("warp");
    expect(targets).not.toContain("spindle");
  });
});

describe("a user adds a category to route domain work", () => {
  const CONFIG = `
    category backend {
      description "Backend APIs and persistence"
      models ["anthropic/claude-sonnet-4-5"]
      triggers ["Use for backend work"]
    }
  `;

  it("gives the host a specialist for that domain alongside the general one", async () => {
    const host = await load({ config: CONFIG, host: ANTHROPIC_HOST });

    expect(host.agentNames()).toContain("shuttle-backend");
    expect(host.agent("shuttle-backend").mode).toBe("subagent");
  });

  it("describes it with the domain the user wrote, so routing has something to read", async () => {
    const host = await load({ config: CONFIG, host: ANTHROPIC_HOST });

    expect(host.agent("shuttle-backend").description).toBe(
      "[weave-managed] Backend APIs and persistence",
    );
  });

  it("allows the orchestrator to delegate to it", async () => {
    const host = await load({ config: CONFIG, host: ANTHROPIC_HOST });

    expect(host.effectFor("loom", "subagent", "shuttle-backend")).toBe("allow");
  });
});

describe("a user gives an agent a display name", () => {
  it("shows the display name while the id they select it by stays the same", async () => {
    const host = await load({
      config: `
        agent scribe {
          display_name "The Scribe"
          description "Writes things down"
          prompt "You are the scribe."
          models ["probe/fast"]
          mode subagent
        }
      `,
    });

    expect(host.agent("scribe").name).toBe("The Scribe");
    expect(host.agent("scribe").id).toBe("scribe");
  });
});

describe("a user keeps an agent's prompt in a file", () => {
  it("gives the host what the file says", async () => {
    const host = await load({
      config: `
        agent scribe {
          prompt_file "scribe.md"
          models ["probe/fast"]
          mode subagent
        }
      `,
      files: { ".weave/prompts/scribe.md": "# Scribe\n\nWrite it all down." },
    });

    expect(String(host.agent("scribe").system)).toContain("Write it all down.");
  });
});

describe("a user's config points at a prompt file that is not there", () => {
  const CONFIG = `
    agent scribe {
      prompt_file "nope.md"
      models ["probe/fast"]
      mode subagent
    }
  `;

  it("registers no agents at all, so the session never runs on a half-read config", async () => {
    const host = await load({ config: CONFIG });

    expect(host.agentNames()).toEqual([]);
  });

  it("reports the catalog as failed rather than as an empty success", async () => {
    expect((await statusOf({ config: CONFIG })).refresh).toBe("failed");
  });
});

describe("a user's config cannot be parsed", () => {
  const BROKEN = "agent {{{ this is not weave";

  it("leaves the session usable with no Weave agents, rather than failing the host", async () => {
    const host = await load({ config: BROKEN });

    expect(host.agentNames()).toEqual([]);
    expect(host.commandNames()).toEqual([]);
  });

  it("still installs the session hooks, so a later working config takes effect", async () => {
    const host = await load({ config: BROKEN });

    expect(host.hookNames()).toEqual(["prompt", "context"]);
  });

  it("reports the failure through the plan panel instead of staying silent", async () => {
    const report = await statusOf({ config: BROKEN });

    expect(report.refresh).toBe("failed");
    expect(report.readiness.nativeAgents).toBe(false);
  });
});

describe("a user's opencode.jsonc gives the plugin an option it does not recognise", () => {
  const INPUT = {
    config: `
      agent scribe {
        prompt "You are the scribe."
        models ["probe/fast"]
        mode subagent
      }
    `,
    host: { options: { projectConfig: true, unknownField: true } },
  };

  it("changes nothing about the host at all, rather than acting on a config it misread", async () => {
    const host = await load(INPUT);

    expect(host.agentNames()).toEqual([]);
    expect(host.commandNames()).toEqual([]);
    expect(host.hookNames()).toEqual([]);
  });
});

describe("a user tells the plugin to ignore the project's config", () => {
  it("registers nothing from the project file they asked it to skip", async () => {
    // The agent declares a model this host *can* run, so if the project file
    // were read it would appear — the absence is the plugin's doing.
    const host = await load({
      config: `
        agent scribe {
          prompt "You are the scribe."
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }
      `,
      host: { ...ANTHROPIC_HOST, options: { projectConfig: false } },
    });

    expect(host.agentNames()).toEqual(BUILTIN_AGENTS);
  });
});

describe("a user names one of their agents as the host's default", () => {
  const CONFIG = `
    agent scribe {
      prompt "You are the scribe."
      models ["probe/fast"]
      mode subagent
    }
  `;

  it("makes it the agent a new session starts on", async () => {
    const host = await load({
      config: CONFIG,
      host: { options: { defaultAgent: "scribe" } },
    });

    expect(host.defaultAgent).toBe("scribe");
  });

  it("leaves the host's own default alone when the name is not one Weave owns", async () => {
    const host = await load({
      config: CONFIG,
      host: { options: { defaultAgent: "somebody-elses-agent" } },
    });

    expect(host.defaultAgent).toBeUndefined();
  });
});

describe("another plugin already registered an agent under a name Weave wants", () => {
  const INPUT = {
    config: `
      agent scribe {
        description "Weave's scribe"
        prompt "You are the scribe."
        models ["probe/fast"]
        mode subagent
      }
    `,
    host: { foreignAgents: ["scribe"] },
  };

  it("leaves the other plugin's agent exactly as it was", async () => {
    const host = await load(INPUT);
    const scribe = host.agent("scribe");

    expect(scribe.description).toBe("a plugin that was here first");
    expect(scribe.system).toBe("foreign prompt");
    expect(scribe.permissions).toEqual([
      { action: "read", resource: "*", effect: "deny" },
    ]);
  });

  it("tells the user a name collided instead of pretending the agent is theirs", async () => {
    const report = await statusOf(INPUT);

    expect(report.issues).toContainEqual({ code: "agent_collision", count: 1 });
    // The builtins are Weave's; the collided `scribe` is not counted among
    // them, so the owned count stays at exactly the builtin set.
    expect(report.agentCount).toBe(BUILTIN_AGENTS.length);
  });
});

describe("a user gives an agent skills", () => {
  const INPUT = {
    config: `
      agent scribe {
        prompt "You are the scribe."
        models ["probe/fast"]
        mode subagent
        skills ["tdd", "time-travel"]
      }
    `,
    host: {
      skills: [{ id: "sk_tdd", name: "tdd" }],
      sessionAgent: "scribe",
    },
  };

  it("attaches the ones the host has to every prompt that agent sends", async () => {
    const prompt = await live(INPUT, (host) => host.promptSession());

    expect(prompt.skills).toEqual([{ id: "sk_tdd" }]);
  });

  it("keeps the skills the caller already chose", async () => {
    const prompt = await live(INPUT, (host) =>
      host.promptSession({ skills: [{ id: "sk_other" }] }),
    );

    expect(prompt.skills).toEqual([{ id: "sk_other" }, { id: "sk_tdd" }]);
  });

  it("reports the skill the host does not have, instead of failing the agent", async () => {
    const report = await statusOf(INPUT);

    expect((await load(INPUT)).agentNames()).toContain("scribe");
    expect(report.issues).toContainEqual({
      code: "skill_unavailable",
      agentName: "scribe",
      count: 1,
    });
  });

  it("attaches nothing when that name belongs to another plugin's agent", async () => {
    // The name is in Weave's catalog but the host's agent under it is not
    // Weave's, so the skills belong to an agent Weave never registered.
    const prompt = await live(
      { ...INPUT, host: { ...INPUT.host, foreignAgents: ["scribe"] } },
      (host) => host.promptSession(),
    );

    expect(prompt.skills).toBeUndefined();
  });
});

describe("a user sets a temperature on an agent", () => {
  const INPUT = {
    config: `
      agent scribe {
        prompt "You are the scribe."
        models ["probe/fast"]
        mode subagent
        temperature 0.25
      }
    `,
  };

  it("applies it to the requests that agent makes", async () => {
    const generation = await live(INPUT, (host) =>
      host.contextForAgent("scribe"),
    );

    expect(generation).toEqual({ temperature: 0.25 });
  });

  it("leaves the agent alone when that name belongs to another plugin", async () => {
    // Same name, but the host's agent under it is not Weave's, so Weave has
    // no business changing how it generates.
    const generation = await live(
      { ...INPUT, host: { foreignAgents: ["scribe"] } },
      (host) => host.contextForAgent("scribe"),
    );

    expect(generation).toEqual({});
  });
});

describe("a user runs the plan command on a plan they wrote", () => {
  const INPUT = {
    files: { ".weave/plans/release.md": PLAN_FILE },
    host: ANTHROPIC_HOST,
  };

  it("switches the session onto Tapestry and its model before sending any work", async () => {
    const calls = await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "release");
      return {
        order: host.sessionCallNames(),
        agent: host.lastSessionCall("switchAgent"),
        model: host.lastSessionCall("switchModel"),
      };
    });

    expect(calls.order).toEqual(["switchAgent", "switchModel", "prompt"]);
    expect(calls.agent).toMatchObject({ agent: "tapestry" });
    expect(calls.model).toMatchObject({
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
    });
  });

  it("tells the agent where the plan is and keeps what the user typed", async () => {
    const prompt = await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "release");
      return host.lastSessionCall("prompt");
    });

    expect(prompt?.text).toContain(".weave/plans/release.md");
    expect(prompt?.text).toContain("release");
  });

  it("does not reuse the command's own message id, so the prompt is a new message", async () => {
    const prompt = await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "release");
      return host.lastSessionCall("prompt");
    });

    expect(prompt?.id).toBeUndefined();
  });

  it("shows the plan's tasks in the panel, with the current and next one marked", async () => {
    const plan = await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "release");
      return (await host.rpc("plan")) as {
        state: string;
        plan: Record<string, unknown>;
      };
    });

    expect(plan.state).toBe("ready");
    expect(plan.plan).toMatchObject({
      name: "release",
      completed: 0,
      total: 2,
      current: { id: "1.a", title: "Compile", state: "pending", depth: 1 },
      next: { id: "2", title: "Ship it", state: "pending", depth: 0 },
    });
  });

  it("tells the panel the plan changed so it can redraw", async () => {
    const events = await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "release");
      return host.planEvents;
    });

    expect(events.map((event) => event.name)).toEqual([
      "plan.changed",
      "plan.changed",
    ]);
  });

  it("shows no plan until one is started", async () => {
    const plan = await live(INPUT, (host) => host.rpc("plan"));

    expect(plan).toMatchObject({ state: "no_plan" });
  });

  it("lists the plans a user can choose from", async () => {
    const plans = await live(INPUT, (host) => host.rpc("plans"));

    expect(plans).toMatchObject({ names: ["release"] });
  });

  it("keeps the project's path out of what it sends back to the panel", async () => {
    const replies = await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "release");
      return [
        await host.rpc("status"),
        await host.rpc("plan"),
        await host.rpc("plans"),
      ];
    });

    for (const reply of replies) {
      expect(JSON.stringify(reply)).not.toContain("weave-opencode2-scenario-");
    }
  });
});

describe("a user finishes every task in the plan they started", () => {
  const INPUT = {
    files: { ".weave/plans/release.md": "# Release\n\n- [x] Build it\n" },
    host: ANTHROPIC_HOST,
  };

  it("says the plan is complete and stops pointing at a task", async () => {
    const plan = (await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "release");
      return host.rpc("plan");
    })) as { state: string; plan: Record<string, unknown> };

    expect(plan.state).toBe("completed");
    expect(plan.plan).toMatchObject({ completed: 1, total: 1 });
    expect(plan.plan).not.toHaveProperty("current");
    expect(plan.plan).not.toHaveProperty("next");
  });
});

describe("the host refuses to install Weave's session hooks", () => {
  const INPUT = { host: { ...ANTHROPIC_HOST, refuseHooks: true } };

  it("still registers the agents, so the session is usable", async () => {
    const host = await load(INPUT);

    expect(host.agentNames()).toEqual(BUILTIN_AGENTS);
    expect(host.hookNames()).toEqual([]);
  });

  it("tells the panel that per-request setup is not ready, rather than claiming it is", async () => {
    const report = await statusOf(INPUT);

    expect(report.readiness).toMatchObject({
      nativeAgents: true,
      requestIntent: false,
    });
  });
});

describe("a user runs the plan command without a usable plan name", () => {
  const INPUT = {
    files: { ".weave/plans/release.md": PLAN_FILE },
    host: ANTHROPIC_HOST,
  };

  it("offers the plans they have when they name none", async () => {
    const reply = await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "");
      return host.lastSessionCall("synthetic");
    });

    expect(reply?.text).toContain("Available: release");
  });

  it("refuses a name that is not a plain plan name, rather than reading the path", async () => {
    const reply = await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "../../etc/passwd");
      return host.lastSessionCall("synthetic");
    });

    expect(reply?.text).toContain("The plan name is invalid");
  });

  it("says so when the plan does not exist", async () => {
    const reply = await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "nosuchplan");
      return host.lastSessionCall("synthetic");
    });

    expect(reply?.text).toBe(
      "The selected plan is missing, invalid, or unavailable.",
    );
  });

  it("changes nothing about the session in any of those cases", async () => {
    const calls = await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "");
      await host.runCommand("weave:start", "../../etc/passwd");
      await host.runCommand("weave:start", "nosuchplan");
      return host.sessionCallNames();
    });

    expect(calls).toEqual(["synthetic", "synthetic", "synthetic"]);
  });
});

describe("the host refuses the work the plan command submits", () => {
  const INPUT = {
    files: { ".weave/plans/release.md": PLAN_FILE },
    host: {
      ...ANTHROPIC_HOST,
      promptFails: true,
      sessionAgent: "previous-agent",
    },
  };

  it("puts the user's agent and model back the way they were", async () => {
    const result = await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "release");
      return {
        order: host.sessionCallNames(),
        agent: host.lastSessionCall("switchAgent"),
        model: host.lastSessionCall("switchModel"),
      };
    });

    expect(result.order).toEqual([
      "switchAgent",
      "switchModel",
      "prompt",
      "switchAgent",
      "switchModel",
      "synthetic",
    ]);
    expect(result.agent).toMatchObject({ agent: "previous-agent" });
    expect(result.model).toMatchObject({
      model: { providerID: "probe", id: "previous" },
    });
  });

  it("says the plan could not be submitted", async () => {
    const reply = await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "release");
      return host.lastSessionCall("synthetic");
    });

    expect(reply?.text).toBe("Weave could not submit the selected plan.");
  });

  it("shows no plan in the panel, so nothing claims work is running", async () => {
    const plan = await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "release");
      return host.rpc("plan");
    });

    expect(plan).toMatchObject({ state: "no_plan" });
  });
});

describe("the session belongs to a different project than the plugin is serving", () => {
  const INPUT = {
    files: { ".weave/plans/release.md": PLAN_FILE },
    host: { ...ANTHROPIC_HOST, sessionDirectory: "/somewhere/else" },
  };

  it("touches nothing in that session when the plan command is run", async () => {
    const calls = await live(INPUT, async (host) => {
      await host.runCommand("weave:start", "release");
      return host.sessionCallNames();
    });

    expect(calls).toEqual([]);
  });

  it.each([
    "status",
    "plan",
    "plans",
    "start",
  ])("refuses the %s request rather than answering about another project", async (method) => {
    const reply = await live(INPUT, (host) =>
      host.rpc(method, { planName: "release" }),
    );

    expect(isRpcFailure(reply) && reply.code).toBe("wrong_location");
  });
});

describe("the plan panel starts a plan itself", () => {
  const INPUT = {
    files: { ".weave/plans/release.md": PLAN_FILE },
    host: ANTHROPIC_HOST,
  };

  it("runs it exactly as the command would", async () => {
    const result = await live(INPUT, async (host) => {
      const reply = await host.rpc("start", { planName: "release" });
      return { reply, calls: host.sessionCallNames() };
    });

    expect(isRpcFailure(result.reply)).toBe(false);
    expect(result.calls).toEqual(["switchAgent", "switchModel", "prompt"]);
  });

  it("reports a plan it cannot run instead of starting nothing quietly", async () => {
    const reply = await live(INPUT, (host) =>
      host.rpc("start", { planName: "nosuchplan" }),
    );

    expect(isRpcFailure(reply) && reply.code).toBe("start_unavailable");
  });
});

describe("the host changes its model or skill inventory while a session is open", () => {
  it("picks the change up and attaches the newly available skill", async () => {
    const prompts = await live(
      {
        config: `
          agent scribe {
            prompt "You are the scribe."
            models ["probe/fast"]
            mode subagent
            skills ["tdd"]
          }
        `,
        host: { sessionAgent: "scribe" },
      },
      async (host) => {
        const before = await host.promptSession();
        host.setSkills([{ id: "sk_tdd", name: "tdd" }]);
        host.emitInventoryChange("skill.updated");
        await Bun.sleep(50);
        return { before, after: await host.promptSession() };
      },
    );

    expect(prompts.before.skills).toBeUndefined();
    expect(prompts.after.skills).toEqual([{ id: "sk_tdd" }]);
  });

  it("re-registers the plan command so it stays reachable after the host reloads", async () => {
    const result = await live({ host: ANTHROPIC_HOST }, async (host) => {
      host.emitInventoryChange("catalog.updated");
      await Bun.sleep(50);
      return { commands: host.commandNames(), disposed: [...host.disposed] };
    });

    expect(result.commands).toEqual(["weave:start"]);
    expect(result.disposed).toEqual(["command"]);
  });
});

describe("the host applies agent transforms lazily, as the real one does", () => {
  it("still ends up holding the agents once it next lists them", async () => {
    const host = await load({
      config: `
        agent scribe {
          prompt "You are the scribe."
          models ["probe/fast"]
          mode subagent
        }
      `,
      host: { lazyAgents: true },
    });

    expect(host.agentNames()).toEqual([...BUILTIN_AGENTS, "scribe"].sort());
  });
});

describe("a user disables the Weave plugin", () => {
  it("gives back everything it registered, leaving the host as it found it", async () => {
    const host = await load({ host: ANTHROPIC_HOST });

    expect(host.disposed.sort()).toEqual([
      "agent",
      "command",
      "context",
      "prompt",
      "rpc",
    ]);
  });
});
