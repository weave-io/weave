/**
 * Adapter scenarios — the OpenCode (V1) runtime surface.
 *
 * [`opencode.scenario.test.ts`](opencode.scenario.test.ts) covers what OpenCode
 * knows at startup. This file covers what happens next, through two black boxes
 * a user can actually observe:
 *
 * 1. **The command menu.** The plugin's `config` hook writes `cfg.command`, so
 *    the commands a user can type — and what each one sends, to which agent —
 *    come out of the same seam the agent scenarios use.
 * 2. **A running OpenCode instance.** Workflow dispatch and SDK-backed
 *    reconciliation reach OpenCode over the SDK rather than the config object,
 *    so the observable outcome is the set of agents OpenCode is left holding.
 *    [`FakeOpenCodeInstance`](../support/opencode.ts) is that instance: a real
 *    in-memory store, not a call recorder, so a restart genuinely sees what the
 *    first run wrote.
 *
 * Both start from `.weave` source in a temporary project, and neither asserts
 * anything in between.
 *
 * ## What the shipped plugin does and does not reach
 *
 * The plugin's `event` hook is a bare early return — SDK reconciliation was
 * deliberately disabled because a `config.update()` per agent made OpenCode
 * reload every plugin. So on the live path the config hook is the only
 * materialization mechanism, and `reconcile-agent.ts` never runs. The
 * consequence is visible in *"a user already has agents and commands of their
 * own in opencode.json"* below: the collision refusal that module exists to
 * make is not reached, and the config hook overwrites the user's agent instead.
 *
 * `runWorkflow`, `startPlanExecution`, `RuntimeCommandProjection` and
 * `OpenCodeAdapter.spawnSubagent` are exported from the package barrel and have
 * **no caller in this repository**. The scenarios that drive them do so the way
 * an embedder would — a real `OpenCodeAdapter` wired to a real OpenCode
 * instance — through the constructor / `init` / `spawnSubagent` seam
 * `docs/testing-strategy.md` names for this bucket, and their `describe` names
 * say so. One scenario pins the fact that OpenCode itself offers none of the
 * `/weave:*` commands those handlers are labelled with.
 */

import { describe, expect, it } from "bun:test";
import { loadConfig } from "@weaveio/weave-config";
import type { WeaveConfig } from "@weaveio/weave-core";
import {
  createInMemoryRuntimeStore,
  materializeAgents,
  type RuntimeStore,
} from "@weaveio/weave-engine";
import { OpenCodeAdapter } from "../../packages/adapters/opencode/src/adapter.js";
import type { OpenCodeClientFacade } from "../../packages/adapters/opencode/src/opencode-client.js";
import { createWeavePlugin } from "../../packages/adapters/opencode/src/plugin.js";
import { runWorkflow } from "../../packages/adapters/opencode/src/run-workflow.js";
import {
  buildOpenCodeHealthReport,
  RuntimeCommandProjection,
} from "../../packages/adapters/opencode/src/runtime-command-projection.js";
import { startPlanExecution } from "../../packages/adapters/opencode/src/start-plan-execution.js";
import {
  FakeOpenCodeInstance,
  heldAgent,
  projectOnlyReader,
  type RegisteredConfig,
  registeredAgent,
  registeredAgentNames,
  registeredCommand,
  registeredCommandNames,
  registeredConfig,
  withWeaveProject,
  writeProjectFile,
} from "../support/opencode.js";
import { dedent } from "../support/scenario.js";

// ---------------------------------------------------------------------------
// Entering Weave the way OpenCode does
// ---------------------------------------------------------------------------

/**
 * Loads the V1 plugin against a project and returns OpenCode's resulting config.
 *
 * `existing` is whatever OpenCode already held — what a user wrote in their own
 * `opencode.json` — so a scenario can watch what Weave does to it.
 */
function load(
  config: string,
  existing: RegisteredConfig = {},
): Promise<RegisteredConfig> {
  return withWeaveProject(dedent(config), (root) =>
    registeredConfig(
      root,
      async (dir, reader, client) => {
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
      },
      existing,
    ),
  );
}

/** What a Weave startup against a live OpenCode leaves behind. */
interface StartedWeave {
  readonly config: WeaveConfig;
  readonly adapter: OpenCodeAdapter;
  /** One message per agent Weave could not materialize, in config order. */
  readonly failures: readonly string[];
}

/**
 * Starts Weave against a running OpenCode: read the project's config, compose
 * the agents, and materialize each one over the SDK.
 *
 * This is the whole of what an OpenCode host does on session start, and it is
 * the seam `docs/testing-strategy.md` names for the adapter bucket — the
 * adapter constructor plus `init` and `spawnSubagent`.
 *
 * The cast is the fake standing in for the SDK client: it implements the three
 * operations the facade declares, and nothing reaches past them.
 */
async function startWeave(
  root: string,
  opencode: FakeOpenCodeInstance,
): Promise<StartedWeave> {
  const configResult = await loadConfig(root, projectOnlyReader(root));
  if (configResult.isErr()) {
    expect(`config failed to load: ${JSON.stringify(configResult.error)}`).toBe(
      "config loads",
    );
    throw new Error("unreachable");
  }

  const adapter = new OpenCodeAdapter({
    projectRoot: root,
    client: opencode as unknown as OpenCodeClientFacade,
  });
  await adapter.init();

  const plan = (
    await materializeAgents({ config: configResult.value })
  )._unsafeUnwrap();

  const failures: string[] = [];
  for (const { descriptor } of plan.agents) {
    const outcome = await adapter.spawnSubagent(descriptor);
    if (outcome.isErr()) failures.push(outcome.error.message);
  }

  return { config: configResult.value, adapter, failures };
}

// ---------------------------------------------------------------------------
// The configs these scenarios are written against
// ---------------------------------------------------------------------------

const SHUTTLE_AND_A_WORKFLOW = `
  agent shuttle {
    description "Shuttle (Domain Specialist)"
    prompt "You are Shuttle, and you know this codebase."
    models ["anthropic/claude-sonnet-4-5"]
    mode subagent

    tool_policy {
      read allow
      write allow
      execute allow
      delegate deny
    }
  }

  workflow ship-it {
    description "Do the work, then do it again"
    version 1

    step first {
      name "First pass"
      type autonomous
      agent shuttle
      prompt "Make a start on {{instance.goal}}"
      completion agent_signal
    }

    step second {
      name "Second pass"
      type autonomous
      agent shuttle
      prompt "Finish {{instance.goal}}"
      completion agent_signal
    }
  }
`;

const SHUTTLE_ONLY = `
  agent shuttle {
    description "Shuttle (Domain Specialist)"
    prompt "You are Shuttle, and you know this codebase."
    models ["anthropic/claude-sonnet-4-5"]
    mode subagent
  }
`;

const JUST_LOOM = `
  agent loom {
    description "Loom (Main Orchestrator)"
    prompt "You are Loom."
    models ["anthropic/claude-sonnet-4-5"]
    mode primary
  }
`;

// ---------------------------------------------------------------------------
// The command menu
// ---------------------------------------------------------------------------

describe("a user opens OpenCode's command menu in a Weave project", () => {
  it("offers exactly the two plan-execution commands, so nothing else Weave names can be typed", async () => {
    const cfg = await load(JUST_LOOM);

    expect(registeredCommandNames(cfg)).toEqual(["start-work", "weave:start"]);
  });

  it("sends both commands to Tapestry, the agent that executes plans", async () => {
    const cfg = await load(JUST_LOOM);

    expect(registeredCommand(cfg, "start-work").agent).toBe("tapestry");
    expect(registeredCommand(cfg, "weave:start").agent).toBe("tapestry");
  });

  it("labels the preferred command in the menu, so the legacy one is distinguishable", async () => {
    const cfg = await load(JUST_LOOM);

    expect(registeredCommand(cfg, "start-work").description).toBe(
      "Start executing a Weave plan created by Pattern",
    );
    expect(registeredCommand(cfg, "weave:start").description).toBe(
      "Start executing a Weave plan (preferred command)",
    );
  });

  it("carries the user's argument and the plan-execution brief into what Tapestry is sent", async () => {
    const cfg = await load(JUST_LOOM);
    const template = registeredCommand(cfg, "weave:start").template as string;

    expect(template).toContain("$ARGUMENTS");
    expect(template).toContain("execute a Weave plan");
    expect(template).toContain("Delegate");
    expect(template).toContain("- [ ]");
  });

  it.each([
    ["start-work", "start-work"],
    ["weave:start", "weave:start"],
  ])("stamps %s with an envelope naming itself, so a reader of the transcript can tell which was typed", async (command, expectedName) => {
    const cfg = await load(JUST_LOOM);
    const template = registeredCommand(cfg, command).template as string;

    expect(template).toContain(`<command-name>${expectedName}</command-name>`);
    expect(template).toContain("<session-id>$SESSION_ID</session-id>");
  });

  it("starts new sessions in Loom rather than OpenCode's own build agent", async () => {
    const cfg = await load(JUST_LOOM);

    expect(cfg.default_agent).toBe("loom");
  });
});

describe("a user turns off Loom", () => {
  it("leaves OpenCode's own default in place rather than pointing at an agent that is gone", async () => {
    const cfg = await load(`
      disable agents ["loom"]

      agent shuttle {
        description "Shuttle"
        prompt "You are Shuttle."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(registeredAgentNames(cfg)).not.toContain("loom");
    expect(cfg.default_agent).toBeUndefined();
  });
});

describe("a user turns off Tapestry, the agent the plan commands dispatch to", () => {
  it("keeps offering both commands, which then name an agent OpenCode does not have", async () => {
    const cfg = await load(`
      disable agents ["tapestry"]

      agent loom {
        description "Loom"
        prompt "You are Loom."
        models ["anthropic/claude-sonnet-4-5"]
        mode primary
      }
    `);

    expect(registeredAgentNames(cfg)).not.toContain("tapestry");
    expect(registeredCommandNames(cfg)).toEqual(["start-work", "weave:start"]);
    expect(registeredCommand(cfg, "weave:start").agent).toBe("tapestry");
  });
});

describe("a user's config does not parse", () => {
  it("leaves the command menu empty, so no half-configured run can be started", async () => {
    const cfg = await load(`agent loom { description "unterminated`);

    expect(registeredCommandNames(cfg)).toEqual([]);
    expect(cfg.default_agent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// What Weave does to the OpenCode config a user already had
// ---------------------------------------------------------------------------

describe("a user already has agents and commands of their own in opencode.json", () => {
  const MY_CONFIG: RegisteredConfig = {
    agent: { notetaker: { prompt: "You take notes for me." } },
    command: { standup: { template: "Summarise yesterday" } },
  };

  it("leaves their own agents and commands in place beside Weave's", async () => {
    const cfg = await load(SHUTTLE_ONLY, structuredClone(MY_CONFIG));

    expect(registeredAgent(cfg, "notetaker")).toEqual({
      prompt: "You take notes for me.",
    });
    expect(registeredCommandNames(cfg)).toEqual([
      "standup",
      "start-work",
      "weave:start",
    ]);
  });

  it("replaces one of their agents outright when Weave declares the same name", async () => {
    // Observed, not intended. `reconcile-agent.ts` exists to refuse exactly
    // this — a same-named agent without the Weave ownership marker is a
    // collision, and Weave is meant to leave it alone. The config hook is the
    // only live materialization path and consults none of it, so the user's
    // agent is overwritten with no warning. See the file docblock.
    const cfg = await load(SHUTTLE_ONLY, {
      agent: { shuttle: { prompt: "My own shuttle, thanks." } },
    });

    expect(registeredAgent(cfg, "shuttle")).toMatchObject({
      prompt: "You are Shuttle, and you know this codebase.",
      description: "Shuttle (Domain Specialist) [weave-managed]",
    });
  });
});

describe("a user installs Weave and writes no config of their own", () => {
  const EMPTY = "# nothing declared yet\n";

  it("hands OpenCode all eight builtin agents, so the project works out of the box", async () => {
    const cfg = await load(EMPTY);

    expect(registeredAgentNames(cfg)).toEqual([
      "loom",
      "pattern",
      "shuttle",
      "spindle",
      "tapestry",
      "thread",
      "warp",
      "weft",
    ]);
  });

  it("gives every builtin a real prompt, rather than an agent that says nothing", async () => {
    // Regression guard: the builtin prompts are read through `import.meta.dir`,
    // which resolves to the adapter's own dist directory once the config
    // package is bundled into the plugin. When that broke, all eight agents
    // registered with an empty prompt.
    const cfg = await load(EMPTY);

    for (const name of registeredAgentNames(cfg)) {
      expect(
        (registeredAgent(cfg, name).prompt as string).length,
      ).toBeGreaterThan(100);
    }
  });

  it("keeps the builtin Shuttle out of the primary agent picker", async () => {
    const cfg = await load(EMPTY);

    expect(registeredAgent(cfg, "shuttle").mode).toBe("subagent");
  });
});

describe("a user names a model without saying which provider runs it", () => {
  it("leaves the model off entirely, so OpenCode falls back to its own rather than failing", async () => {
    const cfg = await load(`
      agent helper {
        description "Helper"
        prompt "You help."
        models ["claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(registeredAgent(cfg, "helper")).not.toHaveProperty("model");
  });

  it("keeps a provider-qualified model exactly as they wrote it", async () => {
    const cfg = await load(SHUTTLE_ONLY);

    expect(registeredAgent(cfg, "shuttle").model).toBe(
      "anthropic/claude-sonnet-4-5",
    );
  });
});

describe("a user picks a model variant for an agent", () => {
  it("passes the variant through to OpenCode", async () => {
    const cfg = await load(`
      agent helper {
        description "Helper"
        prompt "You help."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
        variant "high"
      }
    `);

    expect(registeredAgent(cfg, "helper").variant).toBe("high");
  });

  it("leaves the field off entirely when they pick none, so OpenCode uses its own", async () => {
    const cfg = await load(`
      agent helper {
        description "Helper"
        prompt "You help."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(registeredAgent(cfg, "helper")).not.toHaveProperty("variant");
  });
});

// ---------------------------------------------------------------------------
// What a running OpenCode ends up holding
//
// These enter through the adapter — constructor, `init`, `spawnSubagent` — the
// seam `docs/testing-strategy.md` names for this bucket and the one any host
// embedding `@weaveio/weave-adapter-opencode` uses. The shipped OpenCode plugin
// no longer takes it; see the docblock.
// ---------------------------------------------------------------------------

describe("a host materializes a Weave project into a running OpenCode", () => {
  it("creates each agent in OpenCode with the prompt, model and permissions they declared", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance();
      const { failures } = await startWeave(root, opencode);

      expect(failures).toEqual([]);
      expect(opencode.writes).toContain("create:shuttle");
      expect(heldAgent(opencode, "shuttle")).toMatchObject({
        prompt: "You are Shuttle, and you know this codebase.",
        model: "anthropic/claude-sonnet-4-5",
        mode: "subagent",
        permission: { edit: "allow", bash: "allow" },
      });
    });
  });

  it("marks every agent it creates as Weave-managed in the description OpenCode shows", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance();
      await startWeave(root, opencode);

      expect(heldAgent(opencode, "shuttle").description).toBe(
        "Shuttle (Domain Specialist) [weave-managed]",
      );
    });
  });

  it("creates the builtins alongside the user's own agents, so a bare project is still usable", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance();
      await startWeave(root, opencode);

      expect([...opencode.agents.keys()].sort()).toEqual([
        "loom",
        "pattern",
        "shuttle",
        "spindle",
        "tapestry",
        "thread",
        "warp",
        "weft",
      ]);
    });
  });
});

describe("a host materializes a project again after the user edited an agent", () => {
  it("updates the agent in place, so the new prompt replaces the old one", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance();
      await startWeave(root, opencode);
      const afterFirstStart = opencode.agents.size;

      await writeProjectFile(
        root,
        ".weave/config.weave",
        dedent(SHUTTLE_AND_A_WORKFLOW).replace(
          "You are Shuttle, and you know this codebase.",
          "You are Shuttle, and you write tests first.",
        ),
      );
      opencode.forgetWrites();
      await startWeave(root, opencode);

      expect(opencode.writes).toContain("update:shuttle");
      expect(opencode.writes).not.toContain("create:shuttle");
      expect(opencode.agents.size).toBe(afterFirstStart);
      expect(heldAgent(opencode, "shuttle").prompt).toBe(
        "You are Shuttle, and you write tests first.",
      );
    });
  });

  it("leaves a Weave agent OpenCode still holds but the user has since removed", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance().seedAgent("retired", {
        prompt: "An agent from an earlier config.",
        description: "Retired [weave-managed]",
      });
      await startWeave(root, opencode);

      expect(heldAgent(opencode, "retired").prompt).toBe(
        "An agent from an earlier config.",
      );
      expect(opencode.writes).not.toContain("update:retired");
    });
  });

  it("does not mistake an agent whose name differs only in case for the same one", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance().seedForeignAgent(
        "Shuttle",
        "My capitalised shuttle",
      );
      const { failures } = await startWeave(root, opencode);

      expect(failures).toEqual([]);
      expect(opencode.writes).toContain("create:shuttle");
      expect(heldAgent(opencode, "Shuttle")).toEqual({
        description: "My capitalised shuttle",
      });
    });
  });

  it("does not stack a second ownership marker onto the description each time", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance();
      await startWeave(root, opencode);
      await startWeave(root, opencode);
      await startWeave(root, opencode);

      const description = heldAgent(opencode, "shuttle").description as string;
      expect(description.match(/\[weave-managed\]/g)).toHaveLength(1);
    });
  });

  it("leaves agents OpenCode already had and Weave never declared exactly as they were", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance().seedForeignAgent(
        "my-notetaker",
        "Takes notes for me",
      );
      await startWeave(root, opencode);

      expect(heldAgent(opencode, "my-notetaker")).toEqual({
        description: "Takes notes for me",
      });
      expect(opencode.writes).not.toContain("update:my-notetaker");
    });
  });
});

describe("a host materializes over an agent the user created themselves", () => {
  it("leaves their agent untouched rather than taking the name over", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance().seedForeignAgent(
        "shuttle",
        "My own hand-written shuttle",
      );
      await startWeave(root, opencode);

      expect(heldAgent(opencode, "shuttle")).toEqual({
        description: "My own hand-written shuttle",
      });
      expect(opencode.writes).not.toContain("create:shuttle");
      expect(opencode.writes).not.toContain("update:shuttle");
    });
  });

  it("says which agent clashed and what they can do about it", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance().seedForeignAgent(
        "shuttle",
        "My own hand-written shuttle",
      );
      const { failures } = await startWeave(root, opencode);

      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('agent "shuttle"');
      expect(failures[0]).toContain("is not Weave-managed");
      expect(failures[0]).toContain("Remove the agent manually or rename");
    });
  });

  it("names the agent in a field a host can branch on, not only in prose", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance().seedForeignAgent(
        "shuttle",
        "My own hand-written shuttle",
      );
      const adapter = new OpenCodeAdapter({
        projectRoot: root,
        client: opencode as unknown as OpenCodeClientFacade,
      });
      await adapter.init();
      const plan = (
        await materializeAgents({
          config: (
            await loadConfig(root, projectOnlyReader(root))
          )._unsafeUnwrap(),
        })
      )._unsafeUnwrap();
      const shuttle = plan.agents.find((a) => a.agentName === "shuttle");

      const outcome = await adapter.spawnSubagent(
        (shuttle as NonNullable<typeof shuttle>).descriptor,
      );

      expect(outcome._unsafeUnwrapErr()).toMatchObject({
        type: "ReconcileAgentError",
        agentName: "shuttle",
      });
    });
  });

  it("still registers every agent that did not clash", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance().seedForeignAgent(
        "shuttle",
        "My own hand-written shuttle",
      );
      await startWeave(root, opencode);

      expect(opencode.writes).toContain("create:loom");
      expect(opencode.writes).toContain("create:weft");
    });
  });
});

describe("OpenCode will not answer when a host tries to register Weave's agents", () => {
  it.each([
    ["the agent list cannot be read", "failListAgents", "connection refused"],
    ["an agent cannot be created", "failCreateAgent", "write failed"],
  ])("reports every agent as unregistered when %s", async (_situation, hook, message) => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance();
      (opencode[hook as "failListAgents"] as (m: string) => unknown)(message);

      const { failures } = await startWeave(root, opencode);

      expect(failures).toHaveLength(8);
      expect(failures[0]).toContain(message);
      expect(opencode.agents.size).toBe(0);
    });
  });
});

describe("a host materializes with no connection to OpenCode at all", () => {
  it("registers nothing and reports no failure, so the session still starts", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const configResult = await loadConfig(root, projectOnlyReader(root));
      const adapter = new OpenCodeAdapter({ projectRoot: root });
      await adapter.init();

      const plan = (
        await materializeAgents({ config: configResult._unsafeUnwrap() })
      )._unsafeUnwrap();

      const failures: string[] = [];
      for (const { descriptor } of plan.agents) {
        const outcome = await adapter.spawnSubagent(descriptor);
        if (outcome.isErr()) failures.push(outcome.error.message);
      }

      expect(failures).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Running a workflow
// ---------------------------------------------------------------------------

describe("a user runs a workflow they declared", () => {
  it("asks OpenCode to run the agent each step names, once per step", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance();
      const { config, adapter } = await startWeave(root, opencode);
      opencode.forgetWrites();

      const run = await runWorkflow({
        config,
        workflowName: "ship-it",
        goal: "Ship the release",
        slug: "ship-the-release",
        adapter,
      });

      expect(run.isOk()).toBe(true);
      expect(opencode.writes).toEqual(["update:shuttle", "update:shuttle"]);
    });
  });

  it("reports the run as completed once every step has been dispatched", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance();
      const { config, adapter } = await startWeave(root, opencode);

      const run = await runWorkflow({
        config,
        workflowName: "ship-it",
        goal: "Ship the release",
        slug: "ship-the-release",
        adapter,
      });

      expect(run._unsafeUnwrap()).toMatchObject({
        status: "completed",
        stepsDispatched: 2,
      });
    });
  });

  it("strips the dispatched agent back to an empty prompt, no model and ask-everything permissions", async () => {
    // Observed, not intended: a dispatch carries a placeholder descriptor
    // (`composedPrompt: ""`, `models: []`, a default policy), and the adapter
    // writes it straight over the agent OpenCode already held. Running a
    // workflow therefore costs the user the agent they configured for the rest
    // of the session. See the file docblock.
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance();
      const { config, adapter } = await startWeave(root, opencode);

      expect(heldAgent(opencode, "shuttle")).toMatchObject({
        prompt: "You are Shuttle, and you know this codebase.",
        model: "anthropic/claude-sonnet-4-5",
      });

      await runWorkflow({
        config,
        workflowName: "ship-it",
        goal: "Ship the release",
        slug: "ship-the-release",
        adapter,
      });

      expect(heldAgent(opencode, "shuttle")).toEqual({
        prompt: "",
        mode: "subagent",
        description: "[weave-managed]",
        permission: {
          edit: "ask",
          bash: "ask",
          webfetch: "ask",
          doom_loop: "ask",
          question: "deny",
        },
      });
    });
  });
});

describe("a user runs a workflow name that is not in their config", () => {
  it("names the workflow they asked for and dispatches nothing", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance();
      const { config, adapter } = await startWeave(root, opencode);
      opencode.forgetWrites();

      const run = await runWorkflow({
        config,
        workflowName: "shipp-it",
        goal: "Ship the release",
        slug: "ship-the-release",
        adapter,
      });

      expect(run._unsafeUnwrapErr()).toEqual({
        type: "WorkflowNotFound",
        workflowName: "shipp-it",
      });
      expect(opencode.writes).toEqual([]);
    });
  });
});

describe("a user caps how many steps a workflow may dispatch", () => {
  it("fails the run at the cap, having already dispatched up to it", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance();
      const { config, adapter } = await startWeave(root, opencode);
      opencode.forgetWrites();

      const run = await runWorkflow({
        config,
        workflowName: "ship-it",
        goal: "Ship the release",
        slug: "ship-the-release",
        adapter,
        maxSteps: 1,
      });

      expect(run._unsafeUnwrapErr()).toEqual({
        type: "MaxStepsExceeded",
        maxSteps: 1,
      });
      expect(opencode.writes).toEqual(["update:shuttle"]);
    });
  });

  it("runs to the end when the cap is exactly the number of steps", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance();
      const { config, adapter } = await startWeave(root, opencode);

      const run = await runWorkflow({
        config,
        workflowName: "ship-it",
        goal: "Ship the release",
        slug: "ship-the-release",
        adapter,
        maxSteps: 2,
      });

      expect(run._unsafeUnwrap().stepsDispatched).toBe(2);
    });
  });
});

describe("a workflow step names an agent OpenCode refuses to give up", () => {
  it("stops the run and repeats the collision back, so the cause is not lost", async () => {
    await withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance().seedForeignAgent(
        "shuttle",
        "My own hand-written shuttle",
      );
      const { config, adapter } = await startWeave(root, opencode);
      opencode.forgetWrites();

      const run = await runWorkflow({
        config,
        workflowName: "ship-it",
        goal: "Ship the release",
        slug: "ship-the-release",
        adapter,
      });

      const error = run._unsafeUnwrapErr();
      expect(error.type).toBe("LifecycleError");
      expect(JSON.stringify(error)).toContain("is not Weave-managed");
      expect(opencode.writes).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Executing a plan
// ---------------------------------------------------------------------------

const PLAN_PROJECT = `
  agent shuttle {
    description "Shuttle"
    prompt "You are Shuttle."
    models ["anthropic/claude-sonnet-4-5"]
    mode subagent
  }
`;

/** Starts Weave in a project that also holds `.weave/plans/<name>.md` files. */
async function withPlans<T>(
  plans: Record<string, string>,
  body: (started: StartedWeave, opencode: FakeOpenCodeInstance) => Promise<T>,
): Promise<T> {
  return withWeaveProject(dedent(PLAN_PROJECT), async (root) => {
    for (const [name, contents] of Object.entries(plans)) {
      await writeProjectFile(root, `.weave/plans/${name}.md`, contents);
    }
    const opencode = new FakeOpenCodeInstance();
    const started = await startWeave(root, opencode);
    opencode.forgetWrites();
    return body(started, opencode);
  });
}

describe("a user asks Weave to execute a plan whose tasks are all ticked off", () => {
  it("dispatches the builtin execution workflow's agents in order", async () => {
    await withPlans(
      { "auth-work": "# Auth\n\n- [x] wire it up\n" },
      async ({ config, adapter }, opencode) => {
        const result = await startPlanExecution({
          planName: "auth-work",
          config,
          planStateProvider: adapter.planStateProvider,
          adapter,
        });

        expect(result._unsafeUnwrap()).toMatchObject({
          status: "completed",
          stepsDispatched: 3,
        });
        expect(opencode.writes).toEqual([
          "update:shuttle",
          "update:weft",
          "update:warp",
        ]);
      },
    );
  });
});

describe("a user asks Weave to execute a plan that is not ready", () => {
  it("refuses a plan that is not there, naming it", async () => {
    await withPlans({}, async ({ config, adapter }, opencode) => {
      const result = await startPlanExecution({
        planName: "auth-work",
        config,
        planStateProvider: adapter.planStateProvider,
        adapter,
      });

      expect(result._unsafeUnwrapErr()).toEqual({
        type: "PlanNotFound",
        planName: "auth-work",
      });
      expect(opencode.writes).toEqual([]);
    });
  });

  it("refuses a plan name that would reach outside the plans directory", async () => {
    await withPlans({}, async ({ config, adapter }, opencode) => {
      const result = await startPlanExecution({
        planName: "../../etc/passwd",
        config,
        planStateProvider: adapter.planStateProvider,
        adapter,
      });

      expect(result._unsafeUnwrapErr()).toEqual({
        type: "InvalidPlanName",
        planName: "../../etc/passwd",
      });
      expect(opencode.writes).toEqual([]);
    });
  });

  it("refuses to start at all when Weave has no way to read plan files", async () => {
    await withPlans(
      { "auth-work": "# Auth\n\n- [x] wire it up\n" },
      async ({ config, adapter }, opencode) => {
        const result = await startPlanExecution({
          planName: "auth-work",
          config,
          planStateProvider: undefined,
          adapter,
        });

        expect(result._unsafeUnwrapErr().type).toBe("ProviderUnavailable");
        expect(opencode.writes).toEqual([]);
      },
    );
  });

  it("gives no reason at all when the plan still has unticked tasks", async () => {
    // Observed, not intended. The engine reports `Plan ".weave/plans/auth-work.md"
    // has incomplete checkbox(es)`, and `startPlanExecution`'s error mapping
    // drops it: `command_lifecycle` carries its text on `error.cause.message`,
    // and the mapper only looks at `error.message` and `error.reason`. Every
    // lifecycle failure on this path collapses to one string. The projection
    // path below renders the same failure in full.
    await withPlans(
      { "auth-work": "# Auth\n\n- [ ] wire it up\n" },
      async ({ config, adapter }) => {
        const result = await startPlanExecution({
          planName: "auth-work",
          config,
          planStateProvider: adapter.planStateProvider,
          adapter,
        });

        expect(result._unsafeUnwrapErr()).toEqual({
          type: "WorkflowError",
          cause: {
            type: "LifecycleError",
            cause: {
              type: "policy_decision",
              message: "Unknown command operation error",
            },
          },
        });
      },
    );
  });
});

// ---------------------------------------------------------------------------
// The runtime commands nothing registers
// ---------------------------------------------------------------------------

describe("a host drives Weave's runtime commands, which OpenCode itself never offers", () => {
  /** Runs `body` against a started Weave and a shared runtime store. */
  async function withProjection<T>(
    body: (args: {
      projection: RuntimeCommandProjection;
      store: RuntimeStore;
      started: StartedWeave;
      opencode: FakeOpenCodeInstance;
    }) => Promise<T>,
  ): Promise<T> {
    return withWeaveProject(dedent(SHUTTLE_AND_A_WORKFLOW), async (root) => {
      const opencode = new FakeOpenCodeInstance();
      const started = await startWeave(root, opencode);
      opencode.forgetWrites();
      return body({
        projection: new RuntimeCommandProjection(),
        store: createInMemoryRuntimeStore(),
        started,
        opencode,
      });
    });
  }

  it("reports which run it started and how much of it was applied", async () => {
    await withProjection(async ({ projection, store, started, opencode }) => {
      const result = await projection.handleRunWorkflow({
        workflowName: "ship-it",
        goal: "Ship the release",
        slug: "ship-the-release",
        ownerId: "weave:run",
        store,
        workflows: started.config.workflows,
        adapter: started.adapter,
      });

      expect(result.outcome).toBe("success");
      expect(result.message).toContain("[/weave:run]");
      expect(result.message).toContain('Workflow "ship-it" started');
      expect(result.message).toContain("3 effect(s) applied");
      expect(opencode.writes).toEqual(["update:shuttle", "update:shuttle"]);
    });
  });

  it("reports where a run got to when asked for its status", async () => {
    await withProjection(async ({ projection, store, started }) => {
      const run = await projection.handleRunWorkflow({
        workflowName: "ship-it",
        goal: "Ship the release",
        slug: "ship-the-release",
        ownerId: "weave:run",
        store,
        workflows: started.config.workflows,
        adapter: started.adapter,
      });
      const instanceId =
        run.outcome === "success" ? run.data.workflowInstanceId : "none";

      const status = await projection.handleInspectStatus({
        workflowInstanceId: instanceId,
        store,
      });

      expect(status.outcome).toBe("success");
      expect(status.message).toContain("status=completed");
      expect(status.message).toContain("workflow=ship-it");
      expect(status.message).toContain("step=second");
      expect(status.message).toContain("activeLease=false");
    });
  });

  it.each([
    [
      "a workflow that is not declared",
      (
        p: RuntimeCommandProjection,
        store: RuntimeStore,
        c: WeaveConfig,
        a: OpenCodeAdapter,
      ) =>
        p.handleRunWorkflow({
          workflowName: "no-such-workflow",
          goal: "g",
          slug: "s",
          ownerId: "weave:run",
          store,
          workflows: c.workflows,
          adapter: a,
        }),
      '[/weave:run] Not found: workflow "no-such-workflow"',
    ],
    [
      "a run that does not exist",
      (p: RuntimeCommandProjection, store: RuntimeStore) =>
        p.handleInspectStatus({
          workflowInstanceId: "never-started",
          store,
        }),
      '[/weave:status] Not found: execution "never-started"',
    ],
    [
      "a run that cannot be aborted because it never started",
      (p: RuntimeCommandProjection, store: RuntimeStore) =>
        p.handleAbortExecution({
          workflowInstanceId: "never-started",
          leaseId: "no-lease",
          signal: "cancel",
          store,
        }),
      '[/weave:abort] Not found: execution "never-started"',
    ],
  ])("says which command failed and why for %s", async (_situation, call, expected) => {
    await withProjection(async ({ projection, store, started }) => {
      const result = await call(
        projection,
        store,
        started.config,
        started.adapter,
      );

      expect(result.outcome).toBe("failure");
      expect(result.message).toContain(expected);
    });
  });

  it("names the plan file and the reason when a plan is not ready to execute", async () => {
    await withWeaveProject(dedent(PLAN_PROJECT), async (root) => {
      await writeProjectFile(
        root,
        ".weave/plans/auth-work.md",
        "# Auth\n\n- [ ] wire it up\n",
      );
      const opencode = new FakeOpenCodeInstance();
      const { config, adapter } = await startWeave(root, opencode);

      const result = await new RuntimeCommandProjection().handleStartPlan({
        planName: "auth-work",
        workflowName: "tapestry-execution",
        goal: "Finish the auth work",
        slug: "auth-work",
        ownerId: "weave:start",
        store: createInMemoryRuntimeStore(),
        planStateProvider: adapter.planStateProvider as never,
        workflows: config.workflows,
        adapter,
      });

      expect(result.outcome).toBe("failure");
      expect(result.message).toContain("[/weave:start]");
      expect(result.message).toContain(".weave/plans/auth-work.md");
      expect(result.message).toContain("incomplete checkbox(es)");
    });
  });

  it("refuses to start a plan that is not there, naming it", async () => {
    await withProjection(async ({ projection, store, started }) => {
      const result = await projection.handleStartPlan({
        planName: "no-such-plan",
        workflowName: "ship-it",
        goal: "g",
        slug: "s",
        ownerId: "weave:start",
        store,
        planStateProvider: started.adapter.planStateProvider as never,
        workflows: started.config.workflows,
        adapter: started.adapter,
      });

      expect(result.outcome).toBe("failure");
      expect(result.message).toContain(
        '[/weave:start] Not found: plan "no-such-plan"',
      );
    });
  });

  it("says which field is missing when a plan is started with no way to read plan files", async () => {
    await withProjection(async ({ projection, store, started }) => {
      const result = await projection.handleStartPlan({
        planName: "auth-work",
        workflowName: "ship-it",
        goal: "g",
        slug: "s",
        ownerId: "weave:start",
        store,
        planStateProvider: undefined as never,
        workflows: started.config.workflows,
        adapter: started.adapter,
      });

      expect(result.outcome).toBe("failure");
      expect(result.message).toContain("[/weave:start] Validation error");
      expect(result.message).toContain("planStateProvider");
    });
  });

  it("reports the adapter as degraded even when nothing is wrong with it", async () => {
    // Observed, not intended. `buildOpenCodeHealthReport()` declares twelve
    // capabilities and none of the seven optional ones, and every undeclared
    // optional capability counts as a degraded operation. The "all capabilities
    // satisfied" success branch is therefore unreachable from the adapter's own
    // report — a health check can only ever say "degraded".
    const result = await new RuntimeCommandProjection().handleRuntimeHealth({
      healthReport: buildOpenCodeHealthReport(),
    });

    expect(result.outcome).toBe("degraded");
    expect(result.message).toContain("[/weave:health]");
    expect(result.message).toContain('Adapter "opencode" is ready');
    expect(result.message).toContain("8 degraded, 0 unsupported");
  });
});
