/**
 * DSL scenarios — prompt composition.
 *
 * Bucket: DSL. What a user writes in `prompt` / `prompt_append` is what the
 * model eventually reads, after Weave renders it as a Mustache template and
 * fills in what it knows about the agent. These are the promises behind
 * "the prompt I wrote is the prompt that runs".
 */

import { describe, expect, it } from "bun:test";
import { parseConfig } from "@weaveio/weave-core";
import { agent, dedent, whenMaterialized } from "../support/scenario.js";

describe("a user writes a plain prompt with no template tags", () => {
  it("passes it through unchanged", async () => {
    const plan = await whenMaterialized(`
      agent plain {
        prompt "You are plain. Do exactly this and nothing else."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(agent(plan, "plain").descriptor.composedPrompt).toContain(
      "You are plain. Do exactly this and nothing else.",
    );
  });
});

describe("a user references the agent's own name in their prompt", () => {
  it("fills it in, so the prompt does not have to repeat the config", async () => {
    const plan = await whenMaterialized(`
      agent weaver {
        prompt "You are {{agent.name}}, and you work in {{agent.mode}} mode."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    const composed = agent(plan, "weaver").descriptor.composedPrompt;

    expect(composed).toContain("You are weaver");
    expect(composed).toContain("subagent mode");
    expect(composed).not.toContain("{{agent.name}}");
  });
});

describe("a user appends guidance to an agent's prompt", () => {
  it("keeps the original prompt and adds the appended text after it", async () => {
    const plan = await whenMaterialized(`
      agent shuttle {
        prompt "BASE PROMPT."
        prompt_append "APPENDED GUIDANCE."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    const composed = agent(plan, "shuttle").descriptor.composedPrompt;

    expect(composed).toContain("BASE PROMPT.");
    expect(composed).toContain("APPENDED GUIDANCE.");
    expect(composed.indexOf("BASE PROMPT.")).toBeLessThan(
      composed.indexOf("APPENDED GUIDANCE."),
    );
  });
});

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

    expect(agent(plan, "loom").descriptor.composedPrompt).toContain(
      "shuttle: Shuttle (Domain Specialist)",
    );
  });

  it("carries each target's triggers, so the model knows when to route there", async () => {
    const plan = await whenMaterialized(config);

    expect(agent(plan, "loom").descriptor.composedPrompt).toContain(
      "Use for writing and changing code",
    );
  });

  it("leaves the loop empty for an agent that may not delegate", async () => {
    const plan = await whenMaterialized(config);
    const shuttle = agent(plan, "shuttle").descriptor;

    expect(shuttle.delegationTargets).toEqual([]);
    expect(shuttle.composedPrompt).not.toContain("Shuttle (Domain Specialist)");
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

    const composed = agent(plan, "lonely").descriptor.composedPrompt;

    expect(composed).toContain("You are lonely.");
    expect(composed).not.toContain("{{");
  });
});

describe("a user references a template path Weave does not provide", () => {
  it("fails composition instead of rendering an empty string", async () => {
    const plan = await whenMaterialized(`
      agent typo {
        prompt "You are {{agent.nmae}}."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(plan.agents.map((entry) => entry.agentName)).not.toContain("typo");
    expect(plan.errors.length).toBeGreaterThan(0);
  });
});

describe("a user declares both an inline prompt and a prompt file", () => {
  it("is rejected, rather than one silently winning", () => {
    const result = parseConfig(
      dedent(`
        agent confused {
          prompt "Inline."
          prompt_file "confused.md"
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }
      `),
    );

    expect(result.isErr()).toBe(true);
  });
});

describe("a user declares an agent with no prompt at all", () => {
  it("is reported as a failure for that agent while the others still resolve", async () => {
    const plan = await whenMaterialized(`
      agent good {
        prompt "You are good."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }

      agent promptless {
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(plan.agents.map((entry) => entry.agentName)).toContain("good");
    expect(plan.errors.length).toBeGreaterThan(0);
  });
});
