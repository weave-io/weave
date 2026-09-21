/**
 * DSL scenarios — delegation.
 *
 * Bucket: DSL. A router agent can only hand work to the agents Weave puts in
 * front of it. That list is computed from the config — who is a subagent, who
 * is disabled, who the router excluded — and reaches the model only through
 * the prompt the user wrote. These are the promises behind "this agent can
 * route to that one, and not to the other".
 */

import { describe, expect, it } from "bun:test";
import {
  agent,
  dedent,
  delegatesTo,
  promptFor,
  whenMaterialized,
} from "../support/scenario.js";

describe("a router agent lists what it can delegate to", () => {
  const config = dedent(`
    agent loom {
      description "Loom (Main Orchestrator)"
      prompt """
      You are Loom.

      ## Delegation
      {{#delegation.targets}}
      - {{name}}: {{description}}
      {{#triggers}}
        - {{.}}
      {{/triggers}}
      {{/delegation.targets}}
      """
      models ["anthropic/claude-sonnet-4-5"]
      mode primary

      tool_policy {
        delegate allow
      }
    }

    agent shuttle {
      description "Shuttle (Domain Specialist)"
      prompt "You are Shuttle."
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent

      triggers ["Use for writing and changing code"]
    }
  `);

  it("names each agent it may delegate to", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "loom")).toContain(
      "shuttle: Shuttle (Domain Specialist)",
    );
  });

  it("carries each target's triggers, so the model knows when to route there", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "loom")).toContain(
      "Use for writing and changing code",
    );
  });

  it("leaves the loop empty for an agent that may not delegate", async () => {
    const plan = await whenMaterialized(config);

    expect(delegatesTo(plan, "shuttle")).toEqual([]);
    expect(promptFor(plan, "shuttle")).not.toContain(
      "Shuttle (Domain Specialist)",
    );
  });
});

describe("a user writes delegation guidance but has no targets", () => {
  it("collapses the loop rather than leaving a stray placeholder", async () => {
    const plan = await whenMaterialized(`
      agent lonely {
        prompt """
        You are lonely.
        {{#delegation.targets}}
        - {{name}}
        {{/delegation.targets}}
        """
        models ["anthropic/claude-sonnet-4-5"]
        mode primary

        tool_policy {
          delegate allow
        }
      }
    `);

    const composed = promptFor(plan, "lonely");

    expect(composed).toContain("You are lonely.");
    expect(composed).not.toContain("{{");
  });
});

describe("a config holds a router, two specialists and a second router", () => {
  /**
   * The shape of a real config: one primary agent the user talks to, a couple
   * of subagents it hands work to, and another primary agent that is not a
   * delegation target for anyone.
   */
  const config = `
    agent loom {
      description "Loom"
      prompt "You are Loom."
      models ["anthropic/claude-sonnet-4-5"]
      mode primary

      tool_policy { delegate allow }
    }

    agent tapestry {
      description "Tapestry"
      prompt "You are Tapestry."
      models ["anthropic/claude-sonnet-4-5"]
      mode primary

      tool_policy { delegate allow }
    }

    agent weft {
      description "Weft"
      prompt "You are Weft."
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent
    }

    agent warp {
      description "Warp"
      prompt "You are Warp."
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent
    }
  `;

  it("offers a router every subagent, in the order the config declares them", async () => {
    const plan = await whenMaterialized(config);

    expect(delegatesTo(plan, "loom")).toEqual(["weft", "warp"]);
  });

  it("never offers a router another primary agent, so the user stays in charge of which one they talk to", async () => {
    const plan = await whenMaterialized(config);

    expect(delegatesTo(plan, "loom")).not.toContain("tapestry");
    expect(delegatesTo(plan, "tapestry")).not.toContain("loom");
  });

  it("never offers an agent itself", async () => {
    const plan = await whenMaterialized(`
      agent solo {
        prompt "You are solo."
        models ["anthropic/claude-sonnet-4-5"]
        mode all

        tool_policy { delegate allow }
      }
    `);

    expect(delegatesTo(plan, "solo")).toEqual([]);
  });
});

describe("a user turns an agent off but leaves it declared", () => {
  it("stops every router offering it, not only the harness running it", async () => {
    const plan = await whenMaterialized(`
      agent loom {
        prompt "You are Loom."
        models ["anthropic/claude-sonnet-4-5"]
        mode primary

        tool_policy { delegate allow }
      }

      agent weft {
        prompt "You are Weft."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }

      agent warp {
        prompt "You are Warp."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }

      disable agents ["warp"]
    `);

    expect(delegatesTo(plan, "loom")).toEqual(["weft"]);
  });
});

describe("a user sets delegate to something other than allow", () => {
  const config = (permission: string) => `
    agent router {
      prompt "You are router."
      models ["anthropic/claude-sonnet-4-5"]
      mode primary

      tool_policy { delegate ${permission} }
    }

    agent helper {
      prompt "You are helper."
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent
    }
  `;

  it("keeps the targets when delegation is only gated on approval", async () => {
    const plan = await whenMaterialized(config("ask"));

    expect(delegatesTo(plan, "router")).toEqual(["helper"]);
  });

  it("empties the list when delegation is denied outright", async () => {
    const plan = await whenMaterialized(config("deny"));

    expect(delegatesTo(plan, "router")).toEqual([]);
  });
});

describe("a router should not route to one particular agent", () => {
  const config = `
    agent loom {
      prompt "You are Loom."
      models ["anthropic/claude-sonnet-4-5"]
      mode primary

      tool_policy { delegate allow }

      routing {
        delegation_exclude ["warp"]
      }
    }

    agent tapestry {
      prompt "You are Tapestry."
      models ["anthropic/claude-sonnet-4-5"]
      mode primary

      tool_policy { delegate allow }
    }

    agent warp {
      prompt "You are Warp."
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent
    }
  `;

  it("drops that agent from the excluding router's list", async () => {
    const plan = await whenMaterialized(config);

    expect(delegatesTo(plan, "loom")).toEqual([]);
  });

  it("leaves every other router's list alone, so the agent is hidden and not disabled", async () => {
    const plan = await whenMaterialized(config);

    expect(delegatesTo(plan, "tapestry")).toEqual(["warp"]);
  });

  it("treats an exclusion naming an agent that does not exist as a no-op", async () => {
    const plan = await whenMaterialized(`
      agent loom {
        prompt "You are Loom."
        models ["anthropic/claude-sonnet-4-5"]
        mode primary

        tool_policy { delegate allow }

        routing {
          delegation_exclude ["ghost"]
        }
      }

      agent warp {
        prompt "You are Warp."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(delegatesTo(plan, "loom")).toEqual(["warp"]);
  });
});

describe("two routers are offered the same specialist", () => {
  it("gives each router its own copy, so an adapter editing one leaves the other alone", async () => {
    const plan = await whenMaterialized(`
      agent loom {
        prompt "You are Loom."
        models ["anthropic/claude-sonnet-4-5"]
        mode primary

        tool_policy { delegate allow }
      }

      agent tapestry {
        prompt "You are Tapestry."
        models ["anthropic/claude-sonnet-4-5"]
        mode primary

        tool_policy { delegate allow }
      }

      agent warp {
        description "Warp (Security)"
        prompt "You are Warp."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent

        triggers ["Use for security review"]
      }
    `);

    const loomTarget = agent(plan, "loom").descriptor.delegationTargets[0];
    loomTarget?.triggers.push("Use for anything at all");

    expect(
      agent(plan, "tapestry").descriptor.delegationTargets[0]?.triggers,
    ).toEqual(["Use for security review"]);
  });
});

describe("a user declares an exclusion block but lists nothing in it", () => {
  it("changes nothing, so an emptied list is the same as no list", async () => {
    const plan = await whenMaterialized(`
      agent loom {
        prompt "You are Loom."
        models ["anthropic/claude-sonnet-4-5"]
        mode primary

        tool_policy { delegate allow }

        routing {
          delegation_exclude []
        }
      }

      agent weft {
        prompt "You are Weft."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }

      agent warp {
        prompt "You are Warp."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(delegatesTo(plan, "loom")).toEqual(["weft", "warp"]);
  });
});

describe("a team uses categories alongside a general-purpose shuttle", () => {
  const config = `
    agent loom {
      prompt "You are Loom."
      models ["anthropic/claude-sonnet-4-5"]
      mode primary

      tool_policy { delegate allow }
    }

    agent shuttle {
      description "Shuttle (Domain Specialist)"
      prompt "You are Shuttle."
      models ["anthropic/claude-sonnet-4-5"]
      mode all

      tool_policy { delegate allow }
    }

    agent weft {
      description "Weft (Reviewer)"
      prompt "You are Weft."
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent
    }

    category frontend {
      description "Frontend UI, styling, accessibility"
      triggers ["Use for frontend UI work"]
    }

    category backend {
      description "Backend APIs, services, persistence"
    }
  `;

  it("offers the router the general shuttle and every category shuttle", async () => {
    const plan = await whenMaterialized(config);

    expect(delegatesTo(plan, "loom")).toEqual([
      "shuttle",
      "weft",
      "shuttle-frontend",
      "shuttle-backend",
    ]);
  });

  it("marks which targets came from a category, so a prompt can group them", async () => {
    const plan = await whenMaterialized(config);
    const targets = agent(plan, "loom").descriptor.delegationTargets;

    expect(
      targets.map((target) => `${target.name}:${target.isCategory}`),
    ).toEqual([
      "shuttle:false",
      "weft:false",
      "shuttle-frontend:true",
      "shuttle-backend:true",
    ]);
  });

  it("describes a category target with the category's description, not the base shuttle's", async () => {
    const plan = await whenMaterialized(config);
    const targets = agent(plan, "loom").descriptor.delegationTargets;

    expect(
      targets.find((target) => target.name === "shuttle-frontend")?.description,
    ).toBe("Frontend UI, styling, accessibility");
  });

  it("carries a category's own triggers and invents none for a category without any", async () => {
    const plan = await whenMaterialized(config);
    const targets = agent(plan, "loom").descriptor.delegationTargets;

    expect(
      targets.find((target) => target.name === "shuttle-frontend")?.triggers,
    ).toEqual(["Use for frontend UI work"]);
    expect(
      targets.find((target) => target.name === "shuttle-backend")?.triggers,
    ).toEqual([]);
  });

  it("stops the general shuttle routing into its own category variants", async () => {
    const plan = await whenMaterialized(config);

    expect(delegatesTo(plan, "shuttle")).toEqual(["weft"]);
  });

  it("stops a category shuttle routing to its siblings or back to the general one", async () => {
    const plan = await whenMaterialized(config);

    expect(delegatesTo(plan, "shuttle-frontend")).toEqual(["weft"]);
  });
});

describe("a user disables one category shuttle but keeps the category", () => {
  it("removes it from every router's list as well as from the plan", async () => {
    const plan = await whenMaterialized(`
      agent loom {
        prompt "You are Loom."
        models ["anthropic/claude-sonnet-4-5"]
        mode primary

        tool_policy { delegate allow }
      }

      agent shuttle {
        prompt "You are Shuttle."
        models ["anthropic/claude-sonnet-4-5"]
        mode all
      }

      category frontend { description "Frontend work" }
      category backend { description "Backend work" }

      disable agents ["shuttle-frontend"]
    `);

    expect(delegatesTo(plan, "loom")).toEqual(["shuttle", "shuttle-backend"]);
  });
});

describe("a user names their own agent with the shuttle- prefix", () => {
  it("treats it as an ordinary agent rather than a category variant", async () => {
    const plan = await whenMaterialized(`
      agent helper {
        prompt "You are helper."
        models ["anthropic/claude-sonnet-4-5"]
        mode all

        tool_policy { delegate allow }
      }

      agent shuttle-legacy {
        description "A hand-written agent that happens to be named like one"
        prompt "You are shuttle-legacy."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    const target = agent(plan, "helper").descriptor.delegationTargets.find(
      (candidate) => candidate.name === "shuttle-legacy",
    );

    expect(target?.isCategory).toBe(false);
  });
});
