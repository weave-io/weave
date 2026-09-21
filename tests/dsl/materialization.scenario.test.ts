/**
 * DSL scenarios — the plan an adapter is handed.
 *
 * Bucket: DSL. `materializeAgents` is the seam every adapter and `weave
 * compose` enter through, and what comes back is a plan: an ordered list of
 * agents, where each one came from, and the failures that did not stop the
 * rest. These are the promises a harness relies on to put a user's config on
 * screen.
 */

import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import {
  agent,
  agentNames,
  errorTypes,
  failures,
  type PromptLibrary,
  promptFor,
  promptLibrary,
  whenMaterialized,
  whenMaterializedWith,
} from "../support/scenario.js";

describe("a user writes a config with agents, a category and a reviewer", () => {
  /**
   * The full shape of a resolved plan: what the user declared, what their
   * categories generated, and what their `review_models` generated, in the
   * order an adapter materializes them.
   */
  const config = `
    agent loom {
      prompt "You are Loom."
      models ["anthropic/claude-sonnet-4-5"]
      mode primary
    }

    agent shuttle {
      prompt "You are Shuttle."
      models ["anthropic/claude-sonnet-4-5"]
      mode all
    }

    agent weft {
      prompt "You are Weft."
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent

      review_models ["openai/gpt-5"]
    }

    category frontend { description "Frontend work" }
  `;

  it("lists declared agents first, then category shuttles, then review variants", async () => {
    const plan = await whenMaterialized(config);

    expect(agentNames(plan)).toEqual([
      "loom",
      "shuttle",
      "weft",
      "shuttle-frontend",
      "weft-openai-gpt-5",
    ]);
  });

  it("gives the same order every time, so a harness does not reshuffle between runs", async () => {
    const first = await whenMaterialized(config);
    const second = await whenMaterialized(config);

    expect(agentNames(second)).toEqual(agentNames(first));
  });

  it("says where each agent came from, so a harness need not guess from its name", async () => {
    const plan = await whenMaterialized(config);

    expect(
      plan.agents.map((entry) => `${entry.agentName}=${entry.source}`),
    ).toEqual([
      "loom=explicit",
      "shuttle=explicit",
      "weft=explicit",
      "shuttle-frontend=category-shuttle",
      "weft-openai-gpt-5=review-variant",
    ]);
  });

  it("names the agent and model behind a review variant", async () => {
    const plan = await whenMaterialized(config);

    expect(agent(plan, "weft-openai-gpt-5").reviewMeta).toEqual({
      sourceAgentName: "weft",
      reviewModel: "openai/gpt-5",
    });
    expect(agent(plan, "weft").reviewMeta).toBeUndefined();
  });

  it("reports no failures for a config that resolves cleanly", async () => {
    const plan = await whenMaterialized(config);

    expect(plan.errors).toEqual([]);
  });
});

describe("a user nominates a second model to review with", () => {
  const config = `
    agent weft {
      description "Weft (Reviewer)"
      prompt "You are Weft."
      models ["anthropic/claude-sonnet-4-5"]
      mode all
      temperature 0.1

      tool_policy {
        read allow
        write allow
        execute allow
      }

      review_models ["openai/gpt-5", "anthropic/claude-opus-4-1"]
    }
  `;

  it("names each variant after the agent and the model, with the model made safe for an agent name", async () => {
    const plan = await whenMaterialized(config);

    expect(agentNames(plan)).toEqual([
      "weft",
      "weft-openai-gpt-5",
      "weft-anthropic-claude-opus-4-1",
    ]);
  });

  it("points each variant at exactly the model it reviews with", async () => {
    const plan = await whenMaterialized(config);

    expect(agent(plan, "weft-openai-gpt-5").descriptor.models).toEqual([
      "openai/gpt-5",
    ]);
    expect(agent(plan, "weft").descriptor.models).toEqual([
      "anthropic/claude-sonnet-4-5",
    ]);
  });

  it("makes a variant a read-only subagent, whatever the agent it reviews for may do", async () => {
    const plan = await whenMaterialized(config);
    const variant = agent(plan, "weft-openai-gpt-5").descriptor;

    expect(agent(plan, "weft").descriptor.mode).toBe("all");
    expect(variant.mode).toBe("subagent");
    expect(variant.effectiveToolPolicy).toEqual({
      read: "allow",
      write: "deny",
      execute: "deny",
      delegate: "deny",
      network: "deny",
    });
  });

  it("gives a variant the reviewer's own prompt and temperature", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "weft-openai-gpt-5")).toBe("You are Weft.");
    expect(agent(plan, "weft-openai-gpt-5").descriptor.temperature).toBe(0.1);
  });
});

describe("a user turns off one review variant", () => {
  it("keeps the reviewer and its other variants", async () => {
    const plan = await whenMaterialized(`
      agent weft {
        prompt "You are Weft."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent

        review_models ["openai/gpt-5", "anthropic/claude-opus-4-1"]
      }

      disable agents ["weft-openai-gpt-5"]
    `);

    expect(agentNames(plan)).toEqual([
      "weft",
      "weft-anthropic-claude-opus-4-1",
    ]);
  });
});

describe("a user's own agent is named like a review variant", () => {
  it("reports the collision rather than one silently replacing the other", async () => {
    const plan = await whenMaterialized(`
      agent weft {
        prompt "You are Weft."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent

        review_models ["openai/gpt-5"]
      }

      agent weft-openai-gpt-5 {
        prompt "My hand-written reviewer."
        models ["openai/gpt-5"]
        mode subagent
      }
    `);

    expect(errorTypes(plan)).toEqual(["ReviewVariantConflict"]);
    expect(agentNames(plan)).toEqual(["weft", "weft-openai-gpt-5"]);
  });
});

describe("several agents in one config are broken in different ways", () => {
  it("resolves the good ones and reports each failure against its own agent", async () => {
    const plan = await whenMaterialized(
      `
        agent good {
          prompt "You are good."
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }

        agent promptless {
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }

        agent bad-template {
          prompt "You are {{agent.nmae}}."
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }

        agent missing-file {
          prompt_file "gone.md"
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }

        agent also-good {
          prompt "You are also good."
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }
      `,
      { promptFiles: {} },
    );

    expect(agentNames(plan)).toEqual(["good", "also-good"]);
    expect(failures(plan)).toEqual([
      "promptless: PromptSourceMissingError",
      "bad-template: PromptTemplateError",
      "missing-file: PromptFileReadError",
    ]);
  });

  it("gives back no agents at all when none of them resolve, rather than failing the call", async () => {
    const plan = await whenMaterialized(`
      agent one { models ["anthropic/claude-sonnet-4-5"] mode subagent }
      agent two { models ["anthropic/claude-sonnet-4-5"] mode subagent }
    `);

    expect(agentNames(plan)).toEqual([]);
    expect(failures(plan)).toHaveLength(2);
  });
});

describe("several agents share one prompt file that is not there", () => {
  it("reads it once and still reports every agent waiting on it", async () => {
    const prompts = promptLibrary({});

    const { plan } = await whenMaterializedWith(
      `
        agent one {
          prompt_file "shared.md"
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }

        agent two {
          prompt_file "shared.md"
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }
      `,
      prompts,
    );

    expect(prompts.reads).toEqual(["shared.md"]);
    expect(failures(plan)).toEqual([
      "one: PromptFileReadError",
      "two: PromptFileReadError",
    ]);
  });
});

describe("a user edits a prompt file and resolves their config again", () => {
  it("reads the file afresh, so the second run runs the edited prompt", async () => {
    const config = `
      agent loom {
        prompt_file "loom.md"
        models ["anthropic/claude-sonnet-4-5"]
        mode primary
      }
    `;

    /** A `prompts/` directory whose file the user rewrites between runs. */
    let content = "First draft.";
    const prompts: PromptLibrary = {
      reads: [],
      read(path) {
        prompts.reads.push(path);
        return okAsync(content);
      },
    };

    const before = await whenMaterializedWith(config, prompts);
    content = "Second draft.";
    const after = await whenMaterializedWith(config, prompts);

    expect(promptFor(before.plan, "loom")).toBe("First draft.");
    expect(promptFor(after.plan, "loom")).toBe("Second draft.");
  });
});

describe("a user names their own agent with the shuttle- prefix", () => {
  it("reports it as one they declared, not as something Weave generated", async () => {
    const plan = await whenMaterialized(`
      agent shuttle {
        prompt "You are Shuttle."
        models ["anthropic/claude-sonnet-4-5"]
        mode all
      }

      agent shuttle-legacy {
        prompt "A hand-written agent named like a generated one."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(agent(plan, "shuttle-legacy").source).toBe("explicit");
    expect(agent(plan, "shuttle-legacy").descriptor.category).toBeUndefined();
  });
});

describe("a user gives an agent a label and a variant for the harness UI", () => {
  it("passes both through to the adapter untouched", async () => {
    const plan = await whenMaterialized(`
      agent loom {
        display_name "Loom"
        prompt "You are Loom."
        models ["anthropic/claude-sonnet-4-5"]
        mode primary
        variant "preview"
        skills ["tdd", "code-review"]
      }
    `);

    const descriptor = agent(plan, "loom").descriptor;

    expect(descriptor.name).toBe("loom");
    expect(descriptor.displayName).toBe("Loom");
    expect(descriptor.variant).toBe("preview");
    expect(descriptor.skills).toEqual(["tdd", "code-review"]);
  });

  it("leaves out what the user did not declare, rather than inventing a default", async () => {
    const plan = await whenMaterialized(`
      agent minimal {
        prompt "You are minimal."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    const descriptor = agent(plan, "minimal").descriptor;

    expect(descriptor.displayName).toBeUndefined();
    expect(descriptor.description).toBeUndefined();
    expect(descriptor.variant).toBeUndefined();
    expect(descriptor.temperature).toBeUndefined();
    expect(descriptor.fast).toBeUndefined();
    expect(descriptor.skills).toEqual([]);
  });
});
