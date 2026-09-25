/**
 * Adapter scenarios — the delegation contract, on OpenCode V1 and V2.
 *
 * Bucket: Adapters. A `.weave` file goes in; what comes out is the set of
 * agents the harness ends up holding and the prompts Loom and Tapestry are
 * given. The contract between those two is what a delegation relies on: when
 * an orchestrator sends work to an agent by name, that agent must exist.
 *
 * Two layers of [Spec 38](../../docs/specs/38-spec-delegation-accuracy/38-spec-delegation-accuracy.md)
 * live here, run over the same fixture configs on both adapters:
 *
 * - **L1, materialization.** Every agent in Loom's and Tapestry's delegation
 *   list was registered with the harness; every registered agent has a
 *   provider-qualified model or none; each category yields exactly one
 *   `shuttle-{category}`, and a disabled or failed one yields none.
 * - **L2, prompt.** Every agent-like name in Loom's and Tapestry's rendered
 *   prompt — a delegation-list entry, a backticked name, a `shuttle-*` token,
 *   or a name after "delegate/route/send … to" — is a registered agent.
 *
 * "Registered" means what Weave put into the harness: every agent in
 * OpenCode V1's config, and the Weave-managed agents in the OpenCode 2 host.
 * A foreign agent that happens to hold a name Weave wanted does not count —
 * Weave's prompt describes Weave's agent, not the one that is there.
 *
 * Assertions that fail on `main` today are `it.failing`, each naming the
 * Spec 38 item that fixes it. When that item lands the assertion starts to
 * pass, `it.failing` reports it, and the item turns it into a plain `it`.
 */

import { describe, expect, it } from "bun:test";
import { createWeavePlugin } from "../../packages/adapters/opencode/src/plugin.js";
import {
  registeredAgentNames,
  registeredConfig,
  withWeaveProject,
} from "../support/opencode.js";
import {
  type HostOptions,
  loadWeaveOnOpenCode2,
} from "../support/opencode2.js";
import { dedent } from "../support/scenario.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type HarnessId = "opencode" | "opencode2";

interface Fixture {
  /** Completes "a user starts <harness> …" — the situation, in user terms. */
  readonly situation: string;
  /** The project's `.weave/config.weave`, merged over Weave's builtins. */
  readonly config: string;
  /** The `shuttle-*` agents the harness should hold once Weave has run. */
  readonly shuttles: readonly string[];
  /** Harnesses the situation applies to. Defaults to both. */
  readonly harnesses?: readonly HarnessId[];
  /** Agents another OpenCode 2 plugin registered before Weave ran. */
  readonly foreignAgents?: readonly string[];
  /**
   * Set when Loom and Tapestry are known to offer an agent the harness does
   * not hold — root cause (b), which Spec 38 item 2 fixes.
   */
  readonly offersUnregisteredAgent?: true;
  /**
   * Orchestrators whose prompt is known to name an unregistered agent outside
   * the `shuttle-*` names — root cause (c), which Spec 38 item 3 fixes.
   */
  readonly namesUnregisteredAgentIn?: readonly Orchestrator[];
}

const FIXTURES: readonly Fixture[] = [
  {
    situation: "with only Weave's builtin agents",
    config: "# builtins only",
    shuttles: [],
  },
  {
    situation: "with two categories",
    config: `
      category api {
        description "HTTP handlers and data access"
        models ["anthropic/claude-sonnet-4-5"]
        triggers ["Use for HTTP handlers and data access"]
      }

      category web {
        description "Browser UI and styling"
        triggers ["Use for components and styling"]
      }
    `,
    shuttles: ["shuttle-api", "shuttle-web"],
  },
  {
    situation: "with four categories whose models are declared every way",
    config: `
      category api {
        description "HTTP handlers and data access"
        models ["anthropic/claude-sonnet-4-5"]
      }

      category web {
        description "Browser UI and styling"
      }

      category data {
        description "Migrations and queries"
        models ["claude-haiku-4-5"]
      }

      category infra {
        description "Deployment and CI"
        models ["openai/gpt-6-sol", "anthropic/claude-sonnet-4-5"]
      }
    `,
    shuttles: ["shuttle-api", "shuttle-data", "shuttle-infra", "shuttle-web"],
  },
  {
    situation: "with a builtin and a category shuttle disabled",
    config: `
      category api {
        description "HTTP handlers and data access"
      }

      category web {
        description "Browser UI and styling"
      }

      disable agents ["warp", "shuttle-web"]
    `,
    shuttles: ["shuttle-api"],
    // tapestry.md's <Routing> says "Do not route plan execution tasks to
    // Pattern, Thread, Spindle, Weft, or Warp", naming Warp though it is off.
    namesUnregisteredAgentIn: ["tapestry"],
  },
  {
    situation: "with a category that declares no models",
    config: `
      category docs {
        description "User-facing documentation"
      }
    `,
    shuttles: ["shuttle-docs"],
  },
  {
    situation: "with a category whose model the harness does not offer",
    config: `
      category ml {
        description "Model training pipelines"
        models ["openai/gpt-9"]
      }
    `,
    shuttles: ["shuttle-ml"],
  },
  {
    situation: "with a category whose prompt cannot be composed",
    config: `
      category api {
        description "HTTP handlers and data access"
      }

      category broken {
        description "A category with a template typo"
        prompt_append "Focus on {{nope}}."
      }
    `,
    // The broken category's shuttle never reaches the harness: its prompt
    // fails to render, so the adapter has nothing to register.
    shuttles: ["shuttle-api"],
    offersUnregisteredAgent: true,
  },
  {
    situation:
      "after another plugin registered an agent under a category shuttle's name",
    harnesses: ["opencode2"],
    foreignAgents: ["shuttle-web"],
    config: `
      category api {
        description "HTTP handlers and data access"
      }

      category web {
        description "Browser UI and styling"
      }
    `,
    // The host keeps the foreign `shuttle-web`; Weave's is never inserted.
    shuttles: ["shuttle-api"],
    offersUnregisteredAgent: true,
  },
];

/** The models the OpenCode 2 host offers: the Anthropic builtin defaults. */
const HOST_MODELS: HostOptions["models"] = [
  { providerID: "anthropic", id: "claude-opus-5-5" },
  { providerID: "anthropic", id: "claude-sonnet-5" },
  { providerID: "anthropic", id: "claude-haiku-4-5" },
  { providerID: "anthropic", id: "claude-sonnet-4-5" },
];

// ---------------------------------------------------------------------------
// The two harnesses, reduced to what the contract needs
// ---------------------------------------------------------------------------

/** What one harness holds after Weave has run. */
interface Registered {
  /** Every agent Weave put into the harness, sorted. */
  readonly agents: readonly string[];
  /** Each registered agent's model, rendered as `provider/model`, or none. */
  readonly models: ReadonlyMap<string, string | undefined>;
  /** The prompt the harness gives one registered agent. */
  prompt(agent: string): string;
}

interface Harness {
  readonly id: HarnessId;
  readonly label: string;
  load(fixture: Fixture): Promise<Registered>;
}

const OPENCODE_V1: Harness = {
  id: "opencode",
  label: "OpenCode",
  async load(fixture) {
    const cfg = await withWeaveProject(dedent(fixture.config), (root) =>
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
    // The project starts with no agents of its own, so every agent in the
    // config OpenCode holds is one Weave registered.
    const agents = registeredAgentNames(cfg);
    const entry = (name: string) => cfg.agent?.[name] ?? {};
    return {
      agents,
      models: new Map(
        agents.map((name) => [name, entry(name).model as string | undefined]),
      ),
      prompt: (name) => String(entry(name).prompt ?? ""),
    };
  },
};

const OPENCODE_V2: Harness = {
  id: "opencode2",
  label: "OpenCode 2",
  async load(fixture) {
    const host = await loadWeaveOnOpenCode2({
      config: dedent(fixture.config),
      host: { models: HOST_MODELS, foreignAgents: fixture.foreignAgents },
    });
    const agents = host
      .agentNames()
      .filter((name) =>
        String(host.agent(name).description).startsWith("[weave-managed]"),
      );
    return {
      agents,
      models: new Map(
        agents.map((name) => {
          const model = host.agent(name).model;
          return [
            name,
            model === undefined ? undefined : `${model.providerID}/${model.id}`,
          ];
        }),
      ),
      prompt: (name) => String(host.agent(name).system ?? ""),
    };
  },
};

const HARNESSES: readonly Harness[] = [OPENCODE_V1, OPENCODE_V2];

const ORCHESTRATORS = ["loom", "tapestry"] as const;

type Orchestrator = (typeof ORCHESTRATORS)[number];

// ---------------------------------------------------------------------------
// Reading names out of a rendered prompt
// ---------------------------------------------------------------------------

/** `provider/model`, where the model part may itself contain slashes. */
const PROVIDER_QUALIFIED = /^[^/\s]+\/\S+$/;

/** A single lowercase agent-style identifier, such as `shuttle` or `weft`. */
const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Backticked identifiers in Loom's and Tapestry's prompts that are not agent
 * names. Each one is what the prompt says it is; none is something a model
 * could send work to.
 */
const NOT_AGENT_NAMES = new Set([
  // Todo-list states the prompts tell the orchestrator to set.
  "completed",
  "pending",
  "cancelled",
  // A DSL field name, in Loom's configuration self-modification guidance.
  "prompt",
  // A workflow name, which the user starts explicitly; not an agent.
  "plan-and-execute",
]);

/** The names in a rendered `- **name** — description` delegation list. */
function delegationList(prompt: string): string[] {
  return [...prompt.matchAll(/^- \*\*([^*\s]+)\*\* — /gm)].map(
    (match) => match[1] ?? "",
  );
}

/**
 * Every agent-like name a rendered prompt mentions: its delegation list,
 * backticked identifiers, `shuttle-*` tokens anywhere (including placeholders
 * such as `shuttle-{category}`), and capitalised names after "delegate to",
 * "route to" or "send it to".
 */
function agentLikeNames(prompt: string): string[] {
  const names = new Set(delegationList(prompt));

  for (const [, quoted = ""] of prompt.matchAll(/`([^`\n]+)`/g)) {
    if (IDENTIFIER.test(quoted) && !NOT_AGENT_NAMES.has(quoted)) {
      names.add(quoted);
    }
  }

  for (const [token] of prompt.matchAll(/\bshuttle-[\w{}-]*[\w}]/g)) {
    names.add(token);
  }

  // "delegate to Pattern", "route plan execution tasks to Pattern, Thread,
  // Spindle, Weft, or Warp": up to four lowercase words between the verb and
  // "to", then one capitalised name or a list of them.
  const afterVerb =
    /\b(?:[Dd]elegate|[Rr]oute|[Ss]end)(?: [a-z]+){0,4} to (?:the )?([A-Z][a-z]+(?:(?:,? (?:or|and) |, |\/)[A-Z][a-z]+)*)/g;
  for (const [, list = ""] of prompt.matchAll(afterVerb)) {
    for (const name of list.split(/,? (?:or|and) |, |\//)) {
      names.add(name.toLowerCase());
    }
  }

  return [...names].sort();
}

/** The names in `names` the harness does not hold. */
function unregistered(
  names: readonly string[],
  registered: Registered,
): string[] {
  return names.filter((name) => !registered.agents.includes(name));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

for (const harness of HARNESSES) {
  const fixtures = FIXTURES.filter((fixture) =>
    (fixture.harnesses ?? ["opencode", "opencode2"]).includes(harness.id),
  );

  for (const fixture of fixtures) {
    describe(`a user starts ${harness.label} ${fixture.situation}`, () => {
      let loaded: Promise<Registered> | undefined;
      const registered = () => {
        loaded ??= harness.load(fixture);
        return loaded;
      };

      // --- L1: what the harness holds -----------------------------------

      it("gives every agent it registers a provider-qualified model or none", async () => {
        const { models } = await registered();

        const bare = [...models].filter(
          ([, model]) => model !== undefined && !PROVIDER_QUALIFIED.test(model),
        );
        expect(bare).toEqual([]);
      });

      it("registers exactly one shuttle for each category that can run, and no other", async () => {
        const { agents } = await registered();

        expect(agents.filter((name) => name.startsWith("shuttle-"))).toEqual([
          ...fixture.shuttles,
        ]);
      });

      for (const orchestrator of ORCHESTRATORS) {
        // Spec 38 item 2 (root cause b): `delegation.targets` is built from
        // the merged config, not from what the adapter registered, so an
        // agent that failed to materialize — a prompt that did not compose,
        // or on OpenCode 2 a name another plugin already holds — is still
        // offered. Item 2 makes these pass.
        const offersOnlyRegistered =
          fixture.offersUnregisteredAgent === true ? it.failing : it;

        offersOnlyRegistered(
          `offers ${orchestrator} only agents the harness holds`,
          async () => {
            const current = await registered();
            const list = delegationList(current.prompt(orchestrator));

            expect(list).toContain("shuttle");
            expect(unregistered(list, current)).toEqual([]);
          },
        );

        // --- L2: what the orchestrator's prompt names --------------------

        // Spec 38 item 3 (root cause c): a prompt that names a disabled agent
        // in a prohibition, as tapestry.md's <Routing> does, is known to
        // fail. Item 3 makes these pass.
        const namesOnlyRegistered =
          fixture.namesUnregisteredAgentIn?.includes(orchestrator) === true
            ? it.failing
            : it;

        namesOnlyRegistered(
          `names only registered agents in ${orchestrator}'s prompt, outside shuttle-* names`,
          async () => {
            const current = await registered();
            const names = agentLikeNames(current.prompt(orchestrator)).filter(
              (name) => !name.startsWith("shuttle-"),
            );

            expect(names).toContain("shuttle");
            expect(unregistered(names, current)).toEqual([]);
          },
        );

        // Spec 38 item 3 (root cause c): loom.md names `shuttle-backend`,
        // `shuttle-frontend` and `shuttle-core` (its todo-list example) and
        // the `shuttle-{category}` placeholder; tapestry.md names
        // `shuttle-{category}` in <Delegation> and <Routing>. None is a
        // registered agent in any fixture. Item 3 makes these pass; in the
        // fixtures that also offer an unregistered shuttle, item 2 must land
        // too.
        it.failing(`names only registered shuttles in ${orchestrator}'s prompt`, async () => {
          const current = await registered();
          const shuttles = agentLikeNames(current.prompt(orchestrator)).filter(
            (name) => name.startsWith("shuttle-"),
          );

          expect(unregistered(shuttles, current)).toEqual([]);
        });
      }
    });
  }
}
